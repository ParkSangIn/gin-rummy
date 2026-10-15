//! WebAssembly bridge for the browser game board.
//!
//! It keeps the full game state in Rust and exposes only the player's legal
//! view as JSON. The browser remains responsible for presentation.

use std::{cell::RefCell, str::FromStr};

use gin_rummy::{best_melds, Card, Game, Phase, Player, Rules};
use gin_rummy_engine::{
    DrawAction, MonteCarloBot, Strategy, Table, TurnAction, UpcardAction, View,
};
use rand::rng;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

thread_local! {
    static GAME: RefCell<Option<GameSession>> = const { RefCell::new(None) };
}

struct GameSession {
    game: Game,
    table: Table,
    events: Vec<GameEvent>,
    review_decisions: Vec<ReviewDecision>,
    hand_number: usize,
}

#[derive(Debug, Serialize, Clone)]
struct GameEvent {
    number: usize,
    actor: &'static str,
    action: String,
    phase_after: String,
}

#[derive(Debug, Serialize)]
struct GameView {
    dealer: &'static str,
    turn: Option<&'static str>,
    phase: String,
    player_hand: Vec<String>,
    opponent_hand_len: usize,
    opponent_hand: Option<Vec<String>>,
    discard_pile: Vec<String>,
    stock_len: usize,
    can_take_discard: bool,
    taken_discard: Option<String>,
    deadwood: u8,
    result: Option<RoundOutcome>,
    player_score: u16,
    ai_score: u16,
    target_score: u16,
    match_over: bool,
    match_winner: Option<&'static str>,
    events: Vec<GameEvent>,
    review_decisions: Vec<ReviewDecision>,
}

/// A player decision captured before it is applied.  These assessments use
/// only `Table::view(Player::One)`, so the review never leaks the AI hand.
#[derive(Debug, Serialize, Clone)]
struct ReviewDecision {
    number: usize,
    hand_number: usize,
    phase: String,
    hand: Vec<String>,
    actual: String,
    recommended: String,
    different: bool,
    options: Vec<ReviewOption>,
}

#[derive(Debug, Serialize, Clone)]
struct ReviewOption {
    action: String,
    equity: f64,
    ev: f64,
    recommended: bool,
}

#[derive(Debug, Serialize)]
struct RoundOutcome {
    kind: &'static str,
    winner: Option<&'static str>,
    points: u16,
}
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum PlayerRequest {
    PassUpcard,
    DrawStock,
    DrawDiscard,
    Discard { card: String },
    Knock { card: String },
}

#[derive(Clone, Copy)]
enum HumanMove {
    Upcard(UpcardAction),
    Draw(DrawAction),
    Discard(Card),
    Knock(Card),
}

struct HumanStrategy {
    action: HumanMove,
}

impl Strategy for HumanStrategy {
    fn offer_upcard(&mut self, _: &View<'_>) -> UpcardAction {
        match self.action {
            HumanMove::Upcard(action) => action,
            _ => UpcardAction::Pass,
        }
    }

    fn choose_draw(&mut self, _: &View<'_>) -> DrawAction {
        match self.action {
            HumanMove::Draw(action) => action,
            _ => DrawAction::Stock,
        }
    }

    fn play_turn(&mut self, view: &View<'_>) -> TurnAction {
        match self.action {
            HumanMove::Discard(card) => TurnAction::Discard(card),
            HumanMove::Knock(card) => TurnAction::Knock {
                discard: card,
                melds: best_melds(view.hand() - card.into()),
            },
            _ => TurnAction::Discard(
                view.hand()
                    .into_iter()
                    .next()
                    .expect("discard phase has cards"),
            ),
        }
    }

    fn choose_layoff(&mut self, _: &View<'_>) -> Option<gin_rummy_engine::Layoff> {
        None
    }
}

fn player_name(player: Player) -> &'static str {
    match player {
        Player::One => "player",
        Player::Two => "ai",
    }
}

fn card_code(card: Card) -> String {
    format!("{}{}", card.rank, card.suit.letter())
}

fn cards(cards: impl IntoIterator<Item = Card>) -> Vec<String> {
    cards.into_iter().map(card_code).collect()
}

fn log(session: &mut GameSession, actor: &'static str, action: impl Into<String>) {
    session.events.push(GameEvent {
        number: session.events.len() + 1,
        actor,
        action: action.into(),
        phase_after: session.table.round().phase().to_string(),
    });
}

fn view(session: &GameSession) -> GameView {
    let view = session.table.view(Player::One);
    let result = session.table.round().result();
    let outcome = result.map(|result| RoundOutcome {
        kind: match result {
            gin_rummy::RoundResult::Dead => "dead",
            gin_rummy::RoundResult::Knock { .. } => "knock",
            gin_rummy::RoundResult::Undercut { .. } => "undercut",
            gin_rummy::RoundResult::Gin { .. } => "gin",
            gin_rummy::RoundResult::BigGin { .. } => "big_gin",
            _ => "finished",
        },
        winner: result.winner().map(player_name),
        points: result.points(view.rules()),
    });
    GameView {
        dealer: player_name(view.dealer()),
        turn: session.table.turn().map(player_name),
        phase: view.phase().to_string(),
        player_hand: cards(view.hand()),
        opponent_hand_len: view.opponent_hand_len(),
        opponent_hand: result.map(|_| cards(session.table.round().hand(Player::Two))),
        discard_pile: cards(view.discard_pile().iter().copied()),
        stock_len: view.stock_len(),
        can_take_discard: view.can_take_discard(),
        taken_discard: view.taken_discard().map(card_code),
        deadwood: view.deadwood(),
        result: outcome,
        player_score: session.game.score(Player::One),
        ai_score: session.game.score(Player::Two),
        target_score: session.game.rules().game_target,
        match_over: session.game.is_over(),
        match_winner: session.game.winner().map(player_name),

        events: session.events.clone(),
        review_decisions: session.review_decisions.clone(),
    }
}

fn action_label(action: HumanMove) -> String {
    match action {
        HumanMove::Upcard(UpcardAction::Take) => "take upcard".into(),
        HumanMove::Upcard(UpcardAction::Pass) => "pass".into(),
        HumanMove::Draw(DrawAction::Stock) => "draw stock".into(),
        HumanMove::Draw(DrawAction::TakeDiscard) => "take discard".into(),
        // Match MonteCarloBot::assess, which renders cards with Card's
        // display form (for example, `discard 4♥`).
        HumanMove::Discard(card) => format!("discard {card}"),
        HumanMove::Knock(_) => "knock".into(),
    }
}

fn review_action_label(action: HumanMove, phase: Phase, upcard: Option<Card>) -> String {
    match (action, phase) {
        (HumanMove::Draw(DrawAction::TakeDiscard), Phase::Upcard) => {
            format!("take {}", upcard.expect("upcard phase has an upcard"))
        }
        (HumanMove::Draw(DrawAction::TakeDiscard), _) => {
            format!("take {}", upcard.expect("discard draw has an upcard"))
        }
        (HumanMove::Upcard(UpcardAction::Take), _) => {
            format!("take {}", upcard.expect("upcard phase has an upcard"))
        }
        _ => action_label(action),
    }
}

fn record_review_decision(session: &mut GameSession, action: HumanMove) {
    let player_view = session.table.view(Player::One);
    let phase = player_view.phase();
    let actual = review_action_label(action, phase, player_view.upcard());
    let mut bot = MonteCarloBot::new(rng());
    let options = bot.assess(&player_view);
    if options.is_empty() {
        return;
    }
    let recommended = options
        .iter()
        .find(|option| option.recommended)
        .expect("assess marks exactly one recommended action");
    session.review_decisions.push(ReviewDecision {
        number: session.review_decisions.len() + 1,
        hand_number: session.hand_number,
        phase: phase.to_string(),
        hand: cards(player_view.hand()),
        actual: actual.clone(),
        recommended: recommended.action.clone(),
        different: actual != recommended.action,
        options: options
            .into_iter()
            .map(|option| ReviewOption {
                action: option.action,
                equity: option.equity,
                ev: option.ev,
                recommended: option.recommended,
            })
            .collect(),
    });
}

/// Deal a new round while preserving the match score and next-dealer rule.
/// The table receives those public match facts so score-aware strategies can
/// evaluate this hand in the context of the race to the game target.
fn deal_next_round(game: &Game) -> Table {
    Table::new(game.deal(&mut rng())).scores([
        game.score(Player::One),
        game.score(Player::Two),
    ])
}

fn record_finished_round(session: &mut GameSession) -> Result<(), String> {
    let Some(result) = session.table.round().result() else {
        return Ok(());
    };
    session.game.record(result).map_err(|error| error.to_string())
}

fn apply_ai(session: &mut GameSession) -> Result<(), String> {
    while session.table.turn() == Some(Player::Two) {
        let phase = session.table.round().phase();
        let before_top = session.table.round().discard_pile().last().copied();
        let before_stock_len = session.table.round().stock().len();
        let before_opponent_hand_len = session.table.round().hand(Player::Two).len();
        let mut bot = MonteCarloBot::new(rng());
        session
            .table
            .step(&mut bot)
            .map_err(|error| error.to_string())?;
        let action = match phase {
            Phase::Upcard
                if session.table.round().hand(Player::Two).len() > before_opponent_hand_len =>
            {
                "AI took the first upcard".to_string()
            }
            Phase::Upcard => "AI passed the first upcard".to_string(),
            Phase::Draw if session.table.round().stock().len() < before_stock_len => {
                "AI drew from stock".to_string()
            }
            Phase::Draw => "AI took the discard".to_string(),
            Phase::Discard => match (
                before_top,
                session.table.round().discard_pile().last().copied(),
            ) {
                (_, Some(card)) => format!("AI discarded {}", card_code(card)),
                _ => "AI ended its turn".to_string(),
            },
            Phase::Layoff => "AI finished layoffs".to_string(),
            Phase::Finished => break,
        };
        log(session, "ai", action);
    }
    Ok(())
}

fn apply_human_layoff(session: &mut GameSession) -> Result<(), String> {
    let mut resolved = false;
    while session.table.turn() == Some(Player::One) && session.table.round().phase() == Phase::Layoff {
        let mut bot = MonteCarloBot::new(rng());
        session
            .table
            .step(&mut bot)
            .map_err(|error| error.to_string())?;
        resolved = true;
    }
    if resolved {
        log(session, "player", "automatic layoff resolution");
    }
    Ok(())
}
fn parse_move(request: PlayerRequest) -> Result<(HumanMove, String), String> {
    match request {
        PlayerRequest::PassUpcard => Ok((
            HumanMove::Upcard(UpcardAction::Pass),
            "passed the first upcard".into(),
        )),
        PlayerRequest::DrawStock => {
            Ok((HumanMove::Draw(DrawAction::Stock), "drew from stock".into()))
        }
        PlayerRequest::DrawDiscard => Ok((
            HumanMove::Draw(DrawAction::TakeDiscard),
            "took the discard".into(),
        )),
        PlayerRequest::Discard { card } => {
            let card = Card::from_str(&card).map_err(|_| "invalid card".to_string())?;
            Ok((
                HumanMove::Discard(card),
                format!("discarded {}", card_code(card)),
            ))
        }
        PlayerRequest::Knock { card } => {
            let card = Card::from_str(&card).map_err(|_| "invalid card".to_string())?;
            Ok((
                HumanMove::Knock(card),
                format!("knocked after discarding {}", card_code(card)),
            ))
        }
    }
}

fn encode(value: &GameView) -> Result<String, JsValue> {
    serde_json::to_string(value).map_err(|error| JsValue::from_str(&error.to_string()))
}

/// Starts a new 100-point match with the first dealer chosen randomly.
#[wasm_bindgen]
pub fn start_game() -> Result<String, JsValue> {
    let dealer = if rand::random() {
        Player::One
    } else {
        Player::Two
    };
    let mut rules = Rules::new();
    rules.big_gin_bonus = None;
    let game = Game::new(rules, dealer);
    let table = deal_next_round(&game);
    let mut session = GameSession {
        game,
        table,
        events: Vec::new(),
        review_decisions: Vec::new(),
        hand_number: 1,
    };
    log(
        &mut session,
        "system",
        format!("New hand; {} deals", player_name(dealer)),
    );
    apply_ai(&mut session).map_err(|error| JsValue::from_str(&error))?;
    let response = encode(&view(&session))?;
    GAME.with(|game| *game.borrow_mut() = Some(session));
    Ok(response)
}

/// Starts the next hand of the active match. A completed match must be
/// restarted with `start_game`, preserving the engine's score settlement.
#[wasm_bindgen]
pub fn next_hand() -> Result<String, JsValue> {
    GAME.with(|game| {
        let mut game = game.borrow_mut();
        let session = game
            .as_mut()
            .ok_or_else(|| JsValue::from_str("start a game first"))?;
        if session.table.round().result().is_none() {
            return Err(JsValue::from_str("finish the current hand first"));
        }
        if session.game.is_over() {
            return Err(JsValue::from_str("the match is over; start a new match"));
        }
        session.table = deal_next_round(&session.game);
        session.events.clear();
        session.hand_number += 1;
        log(
            session,
            "system",
            format!("New hand; {} deals", player_name(session.table.round().dealer())),
        );
        apply_ai(session).map_err(|error| JsValue::from_str(&error))?;
        encode(&view(session))
    })
}

/// Applies one player action encoded as the documented JSON request.
#[wasm_bindgen]
pub fn submit_action(request_json: &str) -> Result<String, JsValue> {
    let request: PlayerRequest = serde_json::from_str(request_json)
        .map_err(|error| JsValue::from_str(&format!("invalid action: {error}")))?;
    let (mut action, mut label) = parse_move(request).map_err(|error| JsValue::from_str(&error))?;
    GAME.with(|game| {
        let mut game = game.borrow_mut();
        let session = game
            .as_mut()
            .ok_or_else(|| JsValue::from_str("start a game first"))?;
        if session.table.turn() != Some(Player::One) {
            return Err(JsValue::from_str("it is not the player's turn"));
        }
        if matches!(session.table.round().phase(), Phase::Upcard)
            && matches!(action, HumanMove::Draw(DrawAction::TakeDiscard))
        {
            action = HumanMove::Upcard(UpcardAction::Take);
            label = "took the first upcard".into();
        }
        record_review_decision(session, action);
        let mut human = HumanStrategy { action };
        session
            .table
            .step(&mut human)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        log(session, "player", label);
        apply_ai(session).map_err(|error| JsValue::from_str(&error))?;
        apply_human_layoff(session).map_err(|error| JsValue::from_str(&error))?;
        record_finished_round(session).map_err(|error| JsValue::from_str(&error))?;
        encode(&view(session))
    })
}

/// Returns the current player-safe state without mutating the game.
#[wasm_bindgen]
pub fn current_game() -> Result<String, JsValue> {
    GAME.with(|game| {
        let game = game.borrow();
        let session = game
            .as_ref()
            .ok_or_else(|| JsValue::from_str("start a game first"))?;
        encode(&view(session))
    })
}
