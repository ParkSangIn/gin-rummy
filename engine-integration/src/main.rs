//! Local authoritative game API backed by `gin-rummy-engine`.
//!
//! Run with `cargo run`; the API listens on http://127.0.0.1:8787.

use std::{collections::HashMap, net::SocketAddr, str::FromStr, sync::Arc};

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use gin_rummy::{best_melds, Card, Phase, Player, Rules};
use gin_rummy_engine::{
    DrawAction, MonteCarloBot, Strategy, Table, TurnAction, UpcardAction, View,
};
use rand::rng;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use uuid::Uuid;

type ApiResult<T> = Result<T, ApiError>;
type GameStore = Arc<Mutex<HashMap<Uuid, GameSession>>>;

#[derive(Clone)]
struct AppState {
    games: GameStore,
}

struct GameSession {
    table: Table,
    events: Vec<GameEvent>,
}

#[derive(Debug, Serialize)]
struct ApiError {
    error: String,
}

impl ApiError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            error: message.into(),
        }
    }
    fn not_found() -> Self {
        Self::bad_request("game not found")
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        (StatusCode::BAD_REQUEST, Json(self)).into_response()
    }
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
    id: Uuid,
    dealer: &'static str,
    turn: Option<&'static str>,
    phase: String,
    player_hand: Vec<String>,
    opponent_hand_len: usize,
    discard_pile: Vec<String>,
    stock_len: usize,
    can_take_discard: bool,
    taken_discard: Option<String>,
    deadwood: u8,
    result: Option<String>,
}

#[derive(Debug, Serialize)]
struct ReviewView {
    game: GameView,
    events: Vec<GameEvent>,
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
    fn name(&self) -> &str {
        "human"
    }
}

fn player_name(player: Player) -> &'static str {
    match player {
        Player::One => "player",
        Player::Two => "ai",
    }
}

fn phase_name(phase: Phase) -> String {
    phase.to_string()
}

fn card_list(cards: impl IntoIterator<Item = Card>) -> Vec<String> {
    cards.into_iter().map(|card| card.to_string()).collect()
}

fn game_view(id: Uuid, table: &Table) -> GameView {
    let view = table.view(Player::One);
    GameView {
        id,
        dealer: player_name(view.dealer()),
        turn: table.turn().map(player_name),
        phase: phase_name(view.phase()),
        player_hand: card_list(view.hand()),
        opponent_hand_len: view.opponent_hand_len(),
        discard_pile: card_list(view.discard_pile().iter().copied()),
        stock_len: view.stock_len(),
        can_take_discard: view.can_take_discard(),
        taken_discard: view.taken_discard().map(|card| card.to_string()),
        deadwood: view.deadwood(),
        result: table.round().result().map(|result| format!("{result:?}")),
    }
}

fn log(session: &mut GameSession, actor: &'static str, action: impl Into<String>) {
    session.events.push(GameEvent {
        number: session.events.len() + 1,
        actor,
        action: action.into(),
        phase_after: phase_name(session.table.round().phase()),
    });
}

fn apply_ai_until_player(session: &mut GameSession) -> ApiResult<()> {
    while session.table.turn() == Some(Player::Two) {
        let phase = session.table.round().phase();
        let before_discard = session.table.round().discard_pile().last().copied();
        let before_hand_len = session.table.round().hand(Player::Two).len();
        let mut bot = MonteCarloBot::new(rng());
        session
            .table
            .step(&mut bot)
            .map_err(|error| ApiError::bad_request(error.to_string()))?;
        let action = match phase {
            Phase::Upcard => "AI responded to the first upcard".to_string(),
            Phase::Draw => "AI drew a card".to_string(),
            Phase::Discard => {
                let top = session.table.round().discard_pile().last().copied();
                match (before_discard, top, before_hand_len) {
                    (_, Some(card), _) => format!("AI discarded {card}"),
                    _ => "AI ended its turn".to_string(),
                }
            }
            Phase::Layoff => "AI finished layoffs".to_string(),
            Phase::Finished => break,
        };
        log(session, "ai", action);
    }
    Ok(())
}

async fn create_game(State(state): State<AppState>) -> ApiResult<(StatusCode, Json<GameView>)> {
    let dealer = if rand::random() {
        Player::One
    } else {
        Player::Two
    };
    let table = Table::deal(Rules::new(), dealer, &mut rng());
    let id = Uuid::new_v4();
    let mut session = GameSession {
        table,
        events: Vec::new(),
    };
    log(
        &mut session,
        "system",
        format!("New hand; {} deals", player_name(dealer)),
    );
    apply_ai_until_player(&mut session)?;
    let view = game_view(id, &session.table);
    state.games.lock().await.insert(id, session);
    Ok((StatusCode::CREATED, Json(view)))
}

async fn get_game(
    Path(id): Path<Uuid>,
    State(state): State<AppState>,
) -> ApiResult<Json<GameView>> {
    let games = state.games.lock().await;
    let session = games.get(&id).ok_or_else(ApiError::not_found)?;
    Ok(Json(game_view(id, &session.table)))
}

fn parse_human_move(request: PlayerRequest) -> ApiResult<(HumanMove, String)> {
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
            let card = Card::from_str(&card)
                .map_err(|_| ApiError::bad_request("invalid card; use e.g. 4H or TC"))?;
            Ok((HumanMove::Discard(card), format!("discarded {card}")))
        }
        PlayerRequest::Knock { card } => {
            let card = Card::from_str(&card)
                .map_err(|_| ApiError::bad_request("invalid card; use e.g. 4H or TC"))?;
            Ok((
                HumanMove::Knock(card),
                format!("knocked after discarding {card}"),
            ))
        }
    }
}

async fn submit_action(
    Path(id): Path<Uuid>,
    State(state): State<AppState>,
    Json(request): Json<PlayerRequest>,
) -> ApiResult<Json<GameView>> {
    let (action, label) = parse_human_move(request)?;
    let mut games = state.games.lock().await;
    let session = games.get_mut(&id).ok_or_else(ApiError::not_found)?;
    if session.table.turn() != Some(Player::One) {
        return Err(ApiError::bad_request("it is not the player's turn"));
    }
    let mut human = HumanStrategy { action };
    session
        .table
        .step(&mut human)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    log(session, "player", label);
    apply_ai_until_player(session)?;
    Ok(Json(game_view(id, &session.table)))
}

async fn review_game(
    Path(id): Path<Uuid>,
    State(state): State<AppState>,
) -> ApiResult<Json<ReviewView>> {
    let games = state.games.lock().await;
    let session = games.get(&id).ok_or_else(ApiError::not_found)?;
    Ok(Json(ReviewView {
        game: game_view(id, &session.table),
        events: session.events.clone(),
    }))
}

#[tokio::main]
async fn main() {
    let state = AppState {
        games: Arc::new(Mutex::new(HashMap::new())),
    };
    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/api/games", post(create_game))
        .route("/api/games/{id}", get(get_game))
        .route("/api/games/{id}/actions", post(submit_action))
        .route("/api/games/{id}/review", get(review_game))
        .with_state(state);
    let address: SocketAddr = "127.0.0.1:8787".parse().expect("valid bind address");
    println!("Gin Lab engine API: http://{address}");
    axum::serve(
        tokio::net::TcpListener::bind(address)
            .await
            .expect("bind API port"),
        app,
    )
    .await
    .expect("run API server");
}
