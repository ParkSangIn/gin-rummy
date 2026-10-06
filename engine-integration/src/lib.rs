//! WebAssembly bridge for the browser game board.
//!
//! It keeps the full game state in Rust and exposes only the player's legal
//! view as JSON. The browser remains responsible for presentation.

use std::{cell::RefCell, str::FromStr};

use gin_rummy::{best_melds, Card, Phase, Player, Rules};
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
    table: Table,
    events: Vec<GameEvent>,
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
    events: Vec<GameEvent>,
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

        events: session.events.clone(),
    }
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

/// Starts a new hand with the dealer chosen randomly.
#[wasm_bindgen]
pub fn start_game() -> Result<String, JsValue> {
    let dealer = if rand::random() {
        Player::One
    } else {
        Player::Two
    };
    let table = Table::deal(Rules::new(), dealer, &mut rng());
    let mut session = GameSession {
        table,
        events: Vec::new(),
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
        let mut human = HumanStrategy { action };
        session
            .table
            .step(&mut human)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        log(session, "player", label);
        apply_ai(session).map_err(|error| JsValue::from_str(&error))?;
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
