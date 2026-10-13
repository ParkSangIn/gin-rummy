let engineReady = false;
let engineLoading = false;
let engineWorker;
let engineRequestId = 0;
const engineRequests = new Map();
let engineActionPending = false;
let engineAnimationToken = 0;

function fitTableToViewport() {
  // The PlayOK-like table is authored at this logical size.  Scaling the
  // whole table, rather than stretching individual cards, preserves every
  // card and panel proportion at any desktop browser height.
  const scale = Math.min(window.innerWidth / 1265, window.innerHeight / 714);
  document.documentElement.style.setProperty("--table-scale", String(scale));
}

function usingEngine() { return el.difficulty.value === "engine"; }
function heuristicLevel() { return el.difficulty.value.replace("heuristic-", ""); }

function engineCard(code) {
  const suit = code.at(-1);
  const value = code.slice(0, -1);
  const rank = value === "A" ? 1 : value === "T" ? 10 : value === "J" ? 11 : value === "Q" ? 12 : value === "K" ? 13 : Number(value);
  return { suit, rank, id: `${suit}${rank}` };
}

function applyEngineState(snapshot) {
  state.playerHand = snapshot.player_hand.map(engineCard);
  state.aiHand = snapshot.opponent_hand ? snapshot.opponent_hand.map(engineCard) : makeDeck().slice(0, snapshot.opponent_hand_len);
  state.discard = snapshot.discard_pile.map(engineCard);
  state.deck = Array.from({ length: snapshot.stock_len }, (_, index) => ({ id: `stock-${index}` }));
  state.dealer = snapshot.dealer;
  state.turn = snapshot.turn || "finished";
  state.phase = snapshot.phase;
  state.blockedInitialDiscardId = snapshot.can_take_discard ? null : state.discard.at(-1)?.id || null;
  state.forbiddenDiscardId = snapshot.taken_discard ? engineCard(snapshot.taken_discard).id : null;
  state.drawnCardId = null;
  state.playerScore = snapshot.player_score;
  state.aiScore = snapshot.ai_score;
  state.gameOver = Boolean(snapshot.result);
  const resultReason = {
    dead: "스톡이 두 장 남아 무승부로 종료되었습니다.",
    knock: "노크로 핸드가 종료되었습니다.",
    undercut: "언더컷으로 핸드가 종료되었습니다.",
    gin: "진으로 핸드가 종료되었습니다.",
    big_gin: "빅 진으로 핸드가 종료되었습니다.",
  };
  state.lastResult = snapshot.result ? {
    winner: snapshot.result.winner,
    points: snapshot.result.points,
    reason: resultReason[snapshot.result.kind] || "핸드가 종료되었습니다.",
    matchOver: snapshot.match_over,
  } : null;
  state.aiAction = snapshot.events.at(-1)?.actor === "ai" ? snapshot.events.at(-1).action : "";
  state.log = snapshot.events.map((event) => ({ text: event.action, who: event.actor === "player" ? "you" : event.actor === "ai" ? "ai" : "system" }));
}

function engineCall(method, argument) {
  return new Promise((resolve, reject) => {
    const id = ++engineRequestId;
    engineRequests.set(id, { resolve, reject });
    engineWorker.postMessage({ id, method, argument });
  });
}

function showEngineThinking(action) {
  if (action.type !== "discard") return;
  const discarded = state.playerHand.find((card) => card.id === engineCard(action.card).id);
  if (!discarded) return;
  state.playerHand = state.playerHand.filter((card) => card.id !== discarded.id);
  state.discard = [...state.discard, discarded];
  state.selectedCardId = null;
  state.turn = "ai";
  state.phase = "thinking";
  state.aiAction = "AI가 다음 수를 계산 중입니다…";
  render();
}

async function engineAction(action) {
  if (engineActionPending) return;
  engineActionPending = true;
  const animationToken = ++engineAnimationToken;
  const handCountBefore = state.playerHand.length;
  const isPlayerDraw = action.type === "draw_stock" || action.type === "draw_discard";
  const thinkingStarted = performance.now();
  showEngineThinking(action);
  try {
    const snapshot = JSON.parse(await engineCall("submit_action", JSON.stringify(action)));
    if (isPlayerDraw && snapshot.player_hand.length !== handCountBefore + 1) {
      throw new Error("엔진이 드로우 뒤의 11장 패를 반환하지 않았습니다.");
    }
    const lastPlayerEvent = snapshot.events.map((event, index) => ({ event, index })).filter(({ event }) => event.actor === "player").at(-1)?.index ?? -1;
    const aiEvents = snapshot.events.slice(lastPlayerEvent + 1).filter((event) => event.actor === "ai");
    const drawEvent = aiEvents.find((event) => event.action.startsWith("AI drew") || event.action.startsWith("AI took"));
    const discardEvent = aiEvents.find((event) => event.action.startsWith("AI discarded"));
    if (drawEvent && discardEvent && !snapshot.result) {
      const beforeDraw = structuredClone(snapshot);
      beforeDraw.turn = "ai";
      beforeDraw.phase = "thinking";
      beforeDraw.discard_pile = beforeDraw.discard_pile.slice(0, -1);
      if (drawEvent.action === "AI took the discard") beforeDraw.discard_pile.push(action.card);
      if (drawEvent.action === "AI drew from stock") beforeDraw.stock_len += 1;
      beforeDraw.events = snapshot.events.slice(0, lastPlayerEvent + 1);

      const beforeDiscard = structuredClone(snapshot);
      beforeDiscard.turn = "ai";
      beforeDiscard.phase = "thinking";
      beforeDiscard.opponent_hand_len += 1;
      beforeDiscard.discard_pile = beforeDiscard.discard_pile.slice(0, -1);
      if (drawEvent.action === "AI drew from stock") beforeDiscard.stock_len += 1;
      beforeDiscard.events = [...snapshot.events.slice(0, lastPlayerEvent + 1), drawEvent];

      const showDiscard = () => {
        if (animationToken !== engineAnimationToken) return;
        applyEngineState(beforeDiscard);
        render();
        window.setTimeout(() => {
          if (animationToken !== engineAnimationToken) return;
          applyEngineState(snapshot);
          engineActionPending = false;
          render();
        }, aiDelayMs());
      };

      // A human gets a moment to see the discarded card before the AI chooses a draw source.
      if (action.type === "discard") {
        applyEngineState(beforeDraw);
        render();
        const remainingDelay = Math.max(0, aiDelayMs() - (performance.now() - thinkingStarted));
        window.setTimeout(showDiscard, remainingDelay);
      } else {
        showDiscard();
      }
      return;
    }
    applyEngineState(snapshot);
    engineActionPending = false;
    render();
  } catch (error) {
    engineActionPending = false;
    showToast(error?.message || "엔진이 이 행동을 허용하지 않습니다.");
  }
}

async function startEngineHand(nextHand = false) {
  engineActionPending = false;
  engineAnimationToken += 1;
  const previousDecisions = state?.decisions || [];
  const previousHandNumber = state?.handNumber || 0;
  state = freshState();
  state.handNumber = nextHand ? previousHandNumber + 1 : 1;
  state.decisions = previousDecisions;
  state.decisionCounter = previousDecisions.length;
  try {
    applyEngineState(JSON.parse(await engineCall(nextHand ? "next_hand" : "start_game")));
    render();
  } catch (error) {
    engineReady = false;
    state.turn = "ai";
    state.phase = "thinking";
    state.aiAction = "Engine start failed. Choose New Game to retry.";
    render();
    showToast("Engine start failed. Heuristic AI was not enabled.");
  }
}

async function loadEngine() {
  if (engineLoading || engineReady) return;
  engineLoading = true;
  try {
    engineWorker = new Worker("./engine-worker.js", { type: "module" });
    engineWorker.onmessage = ({ data }) => {
      const request = engineRequests.get(data.id);
      if (!request) return;
      engineRequests.delete(data.id);
      if (data.error) request.reject(new Error(data.error));
      else request.resolve(data.result);
    };
    engineWorker.onerror = (event) => {
      for (const { reject } of engineRequests.values()) reject(event.error || new Error("engine worker failed"));
      engineRequests.clear();
    };
    await engineCall("init");
    engineReady = true;
    if (usingEngine()) startEngineHand();
  } catch (error) {
    engineLoading = false;
    if (usingEngine()) {
      state.turn = "ai";
      state.phase = "thinking";
      state.aiAction = "Engine load failed. Refresh to retry.";
      render();
    }
    showToast("Engine load failed. Heuristic AI was not enabled.");
  }
}
const SUITS = [
  { key: "S", symbol: "♠", name: "스페이드", red: false },
  { key: "H", symbol: "♥", name: "하트", red: true },
  { key: "D", symbol: "♦", name: "다이아", red: true },
  { key: "C", symbol: "♣", name: "클럽", red: false },
];
const RANKS = ["", "A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const TARGET_SCORE = 100;
const STORAGE_KEY = "gin-lab-ai-session-v1";
const FIXED_SUIT_ROWS = { H: 0, C: 1, D: 2, S: 3 };

const el = Object.fromEntries(
  [
    "ai-hand",
    "player-hand",
    "stock-pile",
    "stock-count",
    "discard-pile",
    "discard-card",
    "turn-kicker",
    "turn-message",
    "turn-detail",
    "ai-status-dot",
    "player-status-dot",
    "ai-dealer",
    "player-dealer",
    "player-deadwood",
    "ai-deadwood",
    "ai-action-status",
    "ok-action",
    "knock-action",
    "pass-action",
    "ai-delay",
    "difficulty",
    "new-match",
    "brand-button",
    "player-score",
    "ai-score",
    "hand-number",
    "game-log",
    "hint-button",
    "live-coach",
    "result-overlay",
    "result-kicker",
    "result-title",
    "result-body",
    "open-review",
    "next-hand",
    "review-count",
    "difference-only",
    "summary-total",
    "summary-different",
    "summary-loss",
    "summary-agreement",
    "decision-list-count",
    "decision-list",
    "review-detail",
    "toast",
  ].map((id) => [id, document.getElementById(id)]),
);

let state;
let toastTimer;
let selectedDecisionId = null;

function freshState() {
  return {
    deck: [],
    playerHand: [],
    aiHand: [],
    discard: [],
    seenCards: new Set(),
    playerScore: 0,
    aiScore: 0,
    handNumber: 0,
    dealer: "player",
    upcardPasses: 0,
    blockedInitialDiscardId: null,
    turn: "player",
    phase: "draw",
    selectedCardId: null,
    knockArmed: false,
    forbiddenDiscardId: null,
    aiAction: "",
    gameOver: false,
    log: [],
    decisions: [],
    decisionCounter: 0,
    drawnCardId: null,
    interest: {
      player: { picked: [], discarded: [] },
      ai: { picked: [], discarded: [] },
    },
    lastResult: null,
  };
}

function makeDeck() {
  return SUITS.flatMap((suit) =>
    Array.from({ length: 13 }, (_, index) => ({
      suit: suit.key,
      rank: index + 1,
      id: `${suit.key}${index + 1}`,
    })),
  );
}

function shuffled(cards) {
  const result = cards.slice();
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

function cardValue(card) {
  return Math.min(card.rank, 10);
}

function suitInfo(card) {
  return SUITS.find((suit) => suit.key === card.suit);
}

function cardLabel(card) {
  if (!card) return "—";
  return `${RANKS[card.rank]}${suitInfo(card).symbol}`;
}

function sortCards(cards) {
  const suitOrder = Object.fromEntries(SUITS.map((suit, index) => [suit.key, index]));
  return cards.slice().sort((a, b) => suitOrder[a.suit] - suitOrder[b.suit] || a.rank - b.rank);
}

function combinations(items, size) {
  const result = [];
  function visit(start, chosen) {
    if (chosen.length === size) {
      result.push(chosen.slice());
      return;
    }
    for (let index = start; index <= items.length - (size - chosen.length); index += 1) {
      chosen.push(items[index]);
      visit(index + 1, chosen);
      chosen.pop();
    }
  }
  visit(0, []);
  return result;
}

function generateMeldMasks(hand) {
  const masks = new Set();
  for (let rank = 1; rank <= 13; rank += 1) {
    const indices = hand.map((card, index) => (card.rank === rank ? index : -1)).filter((index) => index >= 0);
    for (const size of [3, 4]) {
      if (indices.length >= size) {
        for (const group of combinations(indices, size)) {
          masks.add(group.reduce((mask, index) => mask | (1 << index), 0));
        }
      }
    }
  }

  for (const suit of SUITS) {
    const suited = hand
      .map((card, index) => ({ card, index }))
      .filter((entry) => entry.card.suit === suit.key)
      .sort((a, b) => a.card.rank - b.card.rank);
    for (let start = 0; start < suited.length; start += 1) {
      let mask = 0;
      for (let end = start; end < suited.length; end += 1) {
        if (end > start && suited[end].card.rank !== suited[end - 1].card.rank + 1) break;
        mask |= 1 << suited[end].index;
        if (end - start + 1 >= 3) masks.add(mask);
      }
    }
  }
  return [...masks];
}

function evaluateHand(hand) {
  const size = 1 << hand.length;
  const meldMasks = generateMeldMasks(hand);
  const meldPoints = new Map(
    meldMasks.map((mask) => [
      mask,
      hand.reduce((sum, card, index) => sum + ((mask & (1 << index)) ? cardValue(card) : 0), 0),
    ]),
  );
  const best = new Array(size).fill(-1);
  const parent = new Array(size).fill(null);
  best[0] = 0;
  for (let used = 0; used < size; used += 1) {
    if (best[used] < 0) continue;
    for (const meld of meldMasks) {
      if (used & meld) continue;
      const next = used | meld;
      const score = best[used] + meldPoints.get(meld);
      if (score > best[next]) {
        best[next] = score;
        parent[next] = { previous: used, meld };
      }
    }
  }
  let bestMask = 0;
  for (let mask = 1; mask < size; mask += 1) {
    if (best[mask] > best[bestMask]) bestMask = mask;
  }
  const melds = [];
  let cursor = bestMask;
  while (cursor && parent[cursor]) {
    const meldMask = parent[cursor].meld;
    melds.push(hand.filter((_, index) => meldMask & (1 << index)));
    cursor = parent[cursor].previous;
  }
  const unmatched = hand.filter((_, index) => !(bestMask & (1 << index)));
  const total = hand.reduce((sum, card) => sum + cardValue(card), 0);
  return { deadwood: total - best[bestMask], melds, unmatched, meldMask: bestMask };
}

function potentialScore(hand) {
  let score = 0;
  for (let rank = 1; rank <= 13; rank += 1) {
    const count = hand.filter((card) => card.rank === rank).length;
    if (count === 2) score += 4;
    if (count >= 3) score += 8;
  }
  for (const suit of SUITS) {
    const ranks = hand.filter((card) => card.suit === suit.key).map((card) => card.rank).sort((a, b) => a - b);
    for (let left = 0; left < ranks.length; left += 1) {
      for (let right = left + 1; right < ranks.length; right += 1) {
        const gap = ranks[right] - ranks[left];
        if (gap === 1) score += 2.5;
        if (gap === 2) score += 1.8;
      }
    }
  }
  return score;
}

function discardRisk(card, actor) {
  const opponent = actor === "player" ? state.interest.ai : state.interest.player;
  let risk = 0;
  for (const picked of opponent.picked) {
    if (picked.rank === card.rank) risk += 4.5;
    if (picked.suit === card.suit && Math.abs(picked.rank - card.rank) === 1) risk += 5;
    if (picked.suit === card.suit && Math.abs(picked.rank - card.rank) === 2) risk += 2;
  }
  for (const discarded of opponent.discarded) {
    if (discarded.id === card.id) risk -= 4;
    if (discarded.rank === card.rank) risk -= 0.8;
  }
  return Math.max(0, risk);
}

function scorePosition(hand, discardedCard, actor) {
  const handEval = evaluateHand(hand);
  const potential = potentialScore(hand);
  const risk = discardRisk(discardedCard, actor);
  const knockBonus = handEval.deadwood === 0 ? 22 : handEval.deadwood <= 10 ? 7 - handEval.deadwood * 0.15 : 0;
  const score = -handEval.deadwood * 4.8 + potential * 1.15 - risk * 1.5 + knockBonus;
  return { score, deadwood: handEval.deadwood, potential, risk, handEval };
}

function bestDiscardOptions(hand, actor, forbiddenId = null) {
  return hand
    .filter((card) => card.id !== forbiddenId)
    .map((card) => {
      const remaining = hand.filter((candidate) => candidate.id !== card.id);
      const evaluation = scorePosition(remaining, card, actor);
      return {
        key: card.id,
        label: cardLabel(card),
        card,
        ...evaluation,
        reason: explainDiscard(evaluation),
      };
    })
    .sort((a, b) => b.score - a.score);
}

function explainDiscard(option) {
  const parts = [`버린 뒤 데드우드 ${option.deadwood}`];
  if (option.potential >= 10) parts.push("연결 가능성이 높습니다");
  else if (option.potential >= 5) parts.push("연결 후보를 유지합니다");
  else parts.push("고립패를 줄입니다");
  if (option.risk >= 4) parts.push("상대에게 유효할 위험이 있습니다");
  return parts.join(" · ");
}

function unseenCardsFor(hand) {
  const unavailable = new Set([...state.seenCards, ...hand.map((card) => card.id)]);
  return makeDeck().filter((card) => !unavailable.has(card.id));
}

function deterministicSample(cards, count, seed) {
  if (count >= cards.length) return cards;
  const start = seed % Math.max(1, cards.length);
  const step = Math.max(1, Math.floor(cards.length / count));
  const result = [];
  const used = new Set();
  let cursor = start;
  while (result.length < count && used.size < cards.length) {
    if (!used.has(cursor)) {
      result.push(cards[cursor]);
      used.add(cursor);
    }
    cursor = (cursor + step) % cards.length;
  }
  return result;
}

function estimateDrawOptions(hand, actor, depth = "strong") {
  const top = state.discard.at(-1);
  const options = [];
  if (top) {
    const takeOptions = bestDiscardOptions([...hand, top], actor, top.id);
    if (takeOptions[0]) {
      options.push({
        key: "discard",
        label: `버림패 ${cardLabel(top)}`,
        score: takeOptions[0].score,
        followUp: takeOptions[0],
        reason: `${cardLabel(top)}를 가져오면 ${takeOptions[0].label}를 버리는 선택이 가장 좋습니다.`,
      });
    }
  }

  const unseen = unseenCardsFor(hand);
  const count = depth === "easy" ? 8 : depth === "medium" ? 18 : unseen.length;
  const sample = deterministicSample(unseen, count, state.handNumber * 17 + state.log.length * 7 + hand.length);
  const stockOutcomes = sample.map((drawn) => bestDiscardOptions([...hand, drawn], actor)[0]).filter(Boolean);
  const average = stockOutcomes.length
    ? stockOutcomes.reduce((sum, option) => sum + option.score, 0) / stockOutcomes.length
    : -999;
  options.push({
    key: "stock",
    label: "덱에서 뽑기",
    score: average,
    reason: `보이지 않은 카드 ${sample.length}장을 가정한 평균 평가입니다.`,
  });
  return options.sort((a, b) => b.score - a.score);
}

function chooseByDifficulty(options, difficulty) {
  if (!options.length) return null;
  if (difficulty === "strong") return options[0];
  const poolSize = difficulty === "medium" ? Math.min(2, options.length) : Math.min(4, options.length);
  const pool = options.slice(0, poolSize);
  const weights = pool.map((_, index) => poolSize - index);
  let ticket = Math.random() * weights.reduce((sum, weight) => sum + weight, 0);
  for (let index = 0; index < pool.length; index += 1) {
    ticket -= weights[index];
    if (ticket <= 0) return pool[index];
  }
  return pool[0];
}

function addLog(text, who = "system") {
  state.log.push({ text, who });
  if (state.log.length > 40) state.log.shift();
}

function startMatch() {
  state = freshState();
  if (usingEngine()) {
    if (engineReady) startEngineHand();
    else showToast("Engine is loading. Please wait.");
    return;
  }
  startHand();
}

function startHand() {
  if (usingEngine()) { if (engineReady) startEngineHand(); else showToast("엔진을 불러오는 중입니다."); return; }
  const scores = state ? { player: state.playerScore, ai: state.aiScore, hand: state.handNumber, dealer: state.dealer } : { player: 0, ai: 0, hand: 0, dealer: null };
  const previousDecisions = state?.decisions || [];
  state = freshState();
  state.playerScore = scores.player;
  state.aiScore = scores.ai;
  state.handNumber = scores.hand + 1;
  state.dealer = scores.hand ? scores.dealer : (Math.random() < 0.5 ? "player" : "ai");
  state.decisions = previousDecisions;
  state.decisionCounter = previousDecisions.length;
  state.deck = shuffled(makeDeck());
  for (let count = 0; count < 10; count += 1) {
    state.playerHand.push(state.deck.pop());
    state.aiHand.push(state.deck.pop());
  }
  const upcard = state.deck.pop();
  state.discard.push(upcard);
  state.seenCards.add(upcard.id);
  addLog(`핸드 ${state.handNumber} 시작 · 첫 업카드 ${cardLabel(upcard)}`);
  state.turn = state.dealer === "player" ? "ai" : "player";
  state.phase = "upcard";
  persist();
  render();
  if (state.turn === "ai") {
    state.phase = "thinking";
    state.aiAction = "AI · 첫 업카드 판단 중";
    render();
    window.setTimeout(aiRespondToUpcard, Math.min(600, aiDelayMs()));
  }
}

function recordDecision({ type, actualKey, actualLabel, options, hand, context }) {
  const recommended = options[0];
  const actual = options.find((option) => option.key === actualKey) || { score: recommended.score, label: actualLabel };
  const loss = Math.max(0, recommended.score - actual.score);
  const decision = {
    id: ++state.decisionCounter,
    handNumber: state.handNumber,
    turnNumber: state.decisions.filter((item) => item.handNumber === state.handNumber).length + 1,
    type,
    actualKey,
    actualLabel,
    recommendedKey: recommended.key,
    recommendedLabel: recommended.label,
    different: recommended.key !== actualKey,
    loss,
    options: options.slice(0, type === "discard" ? 4 : 2).map((option) => ({
      key: option.key,
      label: option.label,
      score: option.score,
      deadwood: option.deadwood,
      potential: option.potential,
      risk: option.risk,
      reason: option.reason,
    })),
    hand: sortCards(hand).map((card) => ({ ...card })),
    context,
  };
  state.decisions.push(decision);
  selectedDecisionId = decision.id;
  persist();
  return decision;
}

function drawPlayer(source) {
  if (state.gameOver || state.turn !== "player") return;
  if (usingEngine()) {
    if (!engineReady) { showToast("엔진을 불러오는 중입니다."); return; }
    if (state.phase === "upcard" && source === "discard") engineAction({ type: "draw_discard" });
    else if (state.phase === "draw") engineAction({ type: source === "discard" ? "draw_discard" : "draw_stock" });
    return;
  }
  const canDraw = state.phase === "draw" || (state.phase === "upcard" && source === "discard");
  if (state.gameOver || state.turn !== "player" || !canDraw) return;
  if (source === "discard" && state.discard.at(-1)?.id === state.blockedInitialDiscardId) return;
  if (source === "stock" && state.deck.length <= 2) {
    finishWithoutScore();
    return;
  }
  const handBefore = state.playerHand.map((card) => ({ ...card }));
  const recommendations = estimateDrawOptions(state.playerHand, "player", "strong");
  const topBefore = state.discard.at(-1);
  let drawn;
  if (source === "discard") {
    drawn = state.discard.pop();
    state.interest.player.picked.push({ ...drawn });
  } else {
    drawn = state.deck.pop();
    state.blockedInitialDiscardId = null;
  }
  state.playerHand.push(drawn);
  state.drawnCardId = drawn.id;
  state.forbiddenDiscardId = source === "discard" ? drawn.id : null;
  state.selectedCardId = null;
  state.knockArmed = false;
  state.phase = "discard";
  recordDecision({
    type: "draw",
    actualKey: source,
    actualLabel: source === "discard" ? `버림패 ${cardLabel(topBefore)}` : "덱에서 뽑기",
    options: recommendations,
    hand: handBefore,
    context: { topDiscard: topBefore ? { ...topBefore } : null },
  });
  addLog(`${source === "discard" ? cardLabel(drawn) + "를 가져옴" : "덱에서 한 장 뽑음"}`, "you");
  render();
}

function aiDelayMs() {
  return Number.parseInt(el["ai-delay"].value, 10) || 600;
}

function playerPassUpcard() {
  if (state.gameOver || state.turn !== "player" || state.phase !== "upcard") return;
  if (usingEngine()) { if (engineReady) engineAction({ type: "pass_upcard" }); else showToast("엔진을 불러오는 중입니다."); return; }
  if (state.gameOver || state.turn !== "player" || state.phase !== "upcard") return;
  state.upcardPasses += 1;
  addLog(`첫 업카드 ${cardLabel(state.discard.at(-1))} 패스`, "you");
  if (state.upcardPasses >= 2) {
    resolveInitialUpcardPasses();
    return;
  }
  state.turn = "ai";
  state.phase = "thinking";
  state.aiAction = "AI · 업카드 판단 중";
  render();
  window.setTimeout(aiRespondToUpcard, Math.min(600, aiDelayMs()));
}

function aiRespondToUpcard() {
  if (state.gameOver || !state.discard.length) return;
  const options = estimateDrawOptions(state.aiHand, "ai", heuristicLevel());
  const choice = chooseByDifficulty(options, heuristicLevel());
  if (choice?.key !== "discard") {
    state.upcardPasses += 1;
    state.aiAction = "AI · 업카드 PASS";
    addLog("AI가 첫 업카드를 패스함");
    if (state.upcardPasses >= 2) {
      resolveInitialUpcardPasses();
      return;
    }
    state.turn = "player";
    state.phase = "upcard";
    render();
    return;
  }
  aiTakeCard("discard");
}

function resolveInitialUpcardPasses() {
  const declined = state.discard.at(-1);
  state.blockedInitialDiscardId = declined?.id || null;
  if (declined) addLog(`첫 업카드 ${cardLabel(declined)}는 이번 첫 드로우에서 제외`);
  state.aiAction = "AI · 첫 업카드 PASS";
  state.phase = "draw";
  state.turn = state.dealer === "player" ? "ai" : "player";
  render();
  if (state.turn === "ai") {
    state.phase = "thinking";
    state.aiAction = "AI · 덱에서 카드 선택 중";
    render();
    window.setTimeout(aiDraw, Math.min(600, aiDelayMs()));
  }
}

function selectPlayerCard(cardId) {
  if (state.turn !== "player" || state.phase !== "discard" || state.gameOver) return;
  if (cardId === state.forbiddenDiscardId) {
    showToast("방금 가져온 버림패는 같은 턴에 다시 버릴 수 없습니다.");
    return;
  }
  state.selectedCardId = cardId;
  playerDiscard(state.knockArmed);
}

function playerDiscard(knock) {
  if (usingEngine()) {
    if (!engineReady) { showToast("엔진을 불러오는 중입니다."); return; }
    const selected = state.playerHand.find((card) => card.id === state.selectedCardId);
    if (selected) engineAction({ type: knock ? "knock" : "discard", card: `${RANKS[selected.rank] === "10" ? "T" : RANKS[selected.rank]}${selected.suit}` });
    return;
  }
  if (!state.selectedCardId || state.turn !== "player" || state.phase !== "discard") return;
  const options = bestDiscardOptions(state.playerHand, "player", state.forbiddenDiscardId);
  const selected = state.playerHand.find((card) => card.id === state.selectedCardId);
  if (!selected) return;
  const remaining = state.playerHand.filter((card) => card.id !== selected.id);
  const evaluation = evaluateHand(remaining);
  if (knock && evaluation.deadwood > 10) {
    showToast("데드우드가 10 이하일 때만 노크할 수 있습니다.");
    return;
  }
  recordDecision({
    type: "discard",
    actualKey: selected.id,
    actualLabel: cardLabel(selected),
    options,
    hand: state.playerHand,
    context: { drawnFrom: state.forbiddenDiscardId ? "discard" : "stock" },
  });
  state.playerHand = remaining;
  state.drawnCardId = null;
  state.discard.push(selected);
  state.seenCards.add(selected.id);
  state.interest.player.discarded.push({ ...selected });
  addLog(`${cardLabel(selected)} 버림${knock ? " · 노크" : ""}`, "you");
  state.selectedCardId = null;
  state.knockArmed = false;
  state.forbiddenDiscardId = null;
  if (knock) {
    finishHand("player");
    return;
  }
  state.turn = "ai";
  state.phase = "thinking";
  state.aiAction = "AI · 카드 선택 중";
  render();
  window.setTimeout(aiDraw, Math.min(600, aiDelayMs()));
}

function armKnock() {
  if (state.turn !== "player" || state.phase !== "discard" || state.gameOver) return;
  const canKnock = state.playerHand.some((card) => card.id !== state.forbiddenDiscardId && evaluateHand(state.playerHand.filter((item) => item.id !== card.id)).deadwood <= 10);
  if (!canKnock) {
    showToast("노크할 수 있는 카드가 없습니다.");
    return;
  }
  state.knockArmed = !state.knockArmed;
  render();
}

function aiTakeCard(source) {
  let drawn;
  if (source === "discard" && state.discard.length) {
    drawn = state.discard.pop();
    state.interest.ai.picked.push({ ...drawn });
    state.forbiddenDiscardId = drawn.id;
    state.aiAction = `AI · 버림패 ${cardLabel(drawn)} 가져옴`;
    addLog(`AI가 버림패 ${cardLabel(drawn)}를 가져옴`);
  } else {
    drawn = state.deck.pop();
    state.blockedInitialDiscardId = null;
    state.forbiddenDiscardId = null;
    state.aiAction = "AI · 덱에서 한 장 가져옴";
    addLog("AI가 덱에서 한 장 가져옴");
  }
  state.aiHand.push(drawn);
  render();
  window.setTimeout(aiDiscard, aiDelayMs());
}

function aiDraw() {
  if (state.gameOver) return;
  if (state.deck.length <= 2) {
    finishWithoutScore();
    return;
  }
  const difficulty = heuristicLevel();
  const drawOptions = estimateDrawOptions(state.aiHand, "ai", difficulty);
  const choice = chooseByDifficulty(drawOptions, difficulty);
  const canTakeDiscard = state.discard.length && state.discard.at(-1)?.id !== state.blockedInitialDiscardId;
  aiTakeCard(choice?.key === "discard" && canTakeDiscard ? "discard" : "stock");
}

function aiDiscard() {
  if (state.gameOver) return;
  const difficulty = heuristicLevel();
  const options = bestDiscardOptions(state.aiHand, "ai", state.forbiddenDiscardId);
  const choice = chooseByDifficulty(options, difficulty) || options[0];
  state.aiHand = state.aiHand.filter((card) => card.id !== choice.card.id);
  state.discard.push(choice.card);
  state.seenCards.add(choice.card.id);
  state.interest.ai.discarded.push({ ...choice.card });
  state.aiAction = `AI · ${cardLabel(choice.card)} 버림`;
  addLog(`AI가 ${cardLabel(choice.card)}를 버림`);
  state.forbiddenDiscardId = null;
  const deadwood = evaluateHand(state.aiHand).deadwood;
  const knockLimit = difficulty === "easy" ? 3 : difficulty === "medium" ? 7 : 10;
  if (deadwood <= knockLimit) {
    addLog(`AI 노크 · 데드우드 ${deadwood}`);
    finishHand("ai");
    return;
  }
  state.turn = "player";
  state.phase = "draw";
  render();
}

function possibleMeldUnionMasks(hand) {
  const melds = generateMeldMasks(hand);
  const reachable = new Set([0]);
  for (const used of [...reachable]) void used;
  let changed = true;
  while (changed) {
    changed = false;
    for (const used of [...reachable]) {
      for (const meld of melds) {
        if (used & meld) continue;
        const next = used | meld;
        if (!reachable.has(next)) {
          reachable.add(next);
          changed = true;
        }
      }
    }
  }
  return [...reachable];
}

function meldState(cards) {
  if (cards.every((card) => card.rank === cards[0].rank)) {
    return { type: "set", rank: cards[0].rank, suits: cards.map((card) => card.suit).sort() };
  }
  const ranks = cards.map((card) => card.rank);
  return { type: "run", suit: cards[0].suit, min: Math.min(...ranks), max: Math.max(...ranks) };
}

function maximumLayoff(cards, knockerMelds) {
  const initialStates = knockerMelds.map(meldState);
  const memo = new Map();
  function stateKey(mask, meldStates) {
    return `${mask}|${meldStates.map((item) => item.type === "set" ? `s${item.rank}:${item.suits.join("")}` : `r${item.suit}:${item.min}-${item.max}`).join("|")}`;
  }
  function search(mask, meldStates) {
    const key = stateKey(mask, meldStates);
    if (memo.has(key)) return memo.get(key);
    let best = 0;
    for (let cardIndex = 0; cardIndex < cards.length; cardIndex += 1) {
      if (!(mask & (1 << cardIndex))) continue;
      const card = cards[cardIndex];
      for (let meldIndex = 0; meldIndex < meldStates.length; meldIndex += 1) {
        const meld = meldStates[meldIndex];
        let nextMeld = null;
        if (meld.type === "set" && meld.rank === card.rank && !meld.suits.includes(card.suit) && meld.suits.length < 4) {
          nextMeld = { ...meld, suits: [...meld.suits, card.suit].sort() };
        }
        if (meld.type === "run" && meld.suit === card.suit && (card.rank === meld.min - 1 || card.rank === meld.max + 1)) {
          nextMeld = { ...meld, min: Math.min(meld.min, card.rank), max: Math.max(meld.max, card.rank) };
        }
        if (!nextMeld) continue;
        const nextStates = meldStates.slice();
        nextStates[meldIndex] = nextMeld;
        best = Math.max(best, cardValue(card) + search(mask & ~(1 << cardIndex), nextStates));
      }
    }
    memo.set(key, best);
    return best;
  }
  return search((1 << cards.length) - 1, initialStates);
}

function deadwoodAfterLayoff(hand, knockerMelds) {
  const total = hand.reduce((sum, card) => sum + cardValue(card), 0);
  let minimum = total;
  for (const meldMask of possibleMeldUnionMasks(hand)) {
    const unmatched = hand.filter((_, index) => !(meldMask & (1 << index)));
    const meldPoints = hand.reduce((sum, card, index) => sum + ((meldMask & (1 << index)) ? cardValue(card) : 0), 0);
    const layoffPoints = maximumLayoff(unmatched, knockerMelds);
    minimum = Math.min(minimum, total - meldPoints - layoffPoints);
  }
  return minimum;
}

function finishHand(knocker) {
  state.gameOver = true;
  state.phase = "complete";
  const knockerHand = knocker === "player" ? state.playerHand : state.aiHand;
  const opponentHand = knocker === "player" ? state.aiHand : state.playerHand;
  const knockerEval = evaluateHand(knockerHand);
  const gin = knockerEval.deadwood === 0;
  const opponentDeadwood = gin
    ? evaluateHand(opponentHand).deadwood
    : deadwoodAfterLayoff(opponentHand, knockerEval.melds);
  let winner = knocker;
  let points;
  let reason;
  if (gin) {
    points = opponentDeadwood + 25;
    reason = `GIN 보너스 25점 + 상대 데드우드 ${opponentDeadwood}`;
  } else if (opponentDeadwood <= knockerEval.deadwood) {
    winner = knocker === "player" ? "ai" : "player";
    points = knockerEval.deadwood - opponentDeadwood + 25;
    reason = `언더컷 보너스 25점 · ${knockerEval.deadwood} 대 ${opponentDeadwood}`;
  } else {
    points = opponentDeadwood - knockerEval.deadwood;
    reason = `데드우드 차이 ${opponentDeadwood} − ${knockerEval.deadwood}`;
  }
  if (winner === "player") state.playerScore += points;
  else state.aiScore += points;
  state.dealer = winner;
  const matchOver = state.playerScore >= TARGET_SCORE || state.aiScore >= TARGET_SCORE;
  state.lastResult = { winner, points, reason, gin, matchOver };
  addLog(`${winner === "player" ? "YOU" : "AI"} +${points}점 · ${reason}`, winner === "player" ? "you" : "system");
  persist();
  render();
}

function finishWithoutScore() {
  state.gameOver = true;
  state.phase = "complete";
  state.lastResult = { winner: null, points: 0, reason: "덱에 카드가 두 장만 남아 무승부 처리되었습니다.", gin: false, matchOver: false };
  addLog("덱 소진 · 이번 핸드는 무승부");
  persist();
  render();
}

function createCardElement(card, { hidden = false, button = false, selected = false, compact = false } = {}) {
  const node = document.createElement(button ? "button" : "span");
  node.className = `card${hidden ? " card-back" : suitInfo(card)?.red ? " red" : ""}${selected ? " selected" : ""}`;
  if (button) {
    node.type = "button";
    node.setAttribute("aria-label", `${cardLabel(card)} 선택`);
  }
  if (compact) node.classList.add("compact-card");
  if (hidden) {
    const pattern = document.createElement("span");
    pattern.className = "back-pattern";
    pattern.textContent = "♠";
    node.append(pattern);
    return node;
  }
  const index = document.createElement("span");
  index.className = "card-index card-index-top";
  index.innerHTML = `<span class="card-value">${RANKS[card.rank]}</span><span class="card-index-suit">${suitInfo(card).symbol}</span>`;
  const pip = document.createElement("span");
  pip.className = "card-pip";
  pip.textContent = suitInfo(card).symbol;
  // Standard playing cards repeat their value in the opposite corner.  Reuse
  // the same DOM rather than requiring a separate image for every card face.
  const bottomIndex = index.cloneNode(true);
  bottomIndex.className = "card-index card-index-bottom";
  node.append(index, pip, bottomIndex);
  return node;
}

function renderHands() {
  el["player-hand"].replaceChildren();
  const orderedPlayerCards = state.playerHand.slice().sort((a, b) => FIXED_SUIT_ROWS[a.suit] - FIXED_SUIT_ROWS[b.suit] || a.rank - b.rank);
  for (const card of orderedPlayerCards) {
    const node = createCardElement(card, { button: true, selected: state.selectedCardId === card.id });
    const row = FIXED_SUIT_ROWS[card.suit];
    node.classList.add("layout-card", `suit-row-${row}`);
    node.classList.toggle("covered-card", state.playerHand.some((other) => other.rank === card.rank && FIXED_SUIT_ROWS[other.suit] > row));
    node.classList.toggle("drawn-card", state.drawnCardId === card.id);
    node.disabled = state.turn !== "player" || state.phase !== "discard" || state.gameOver;
    const rowOffsets = [
      "0px",
      "var(--layout-row-step)",
      "calc(var(--layout-row-step) + var(--layout-row-step))",
      "calc(var(--layout-row-step) + var(--layout-row-step) + var(--layout-row-step))",
    ];
    node.style.top = rowOffsets[row];
    node.style.left = `${(card.rank - 1) * 6.5}%`;
    node.style.zIndex = String(10 + row * 13 + card.rank);
    node.addEventListener("click", () => selectPlayerCard(card.id));
    el["player-hand"].append(node);
  }

  el["ai-hand"].replaceChildren();
  el["ai-hand"].classList.toggle("final-hand", state.gameOver);
  el["ai-hand"].closest(".opponent-zone").classList.toggle("show-final-hand", state.gameOver);
  const orderedAiCards = sortCards(state.aiHand);
  for (const card of orderedAiCards) {
    const node = createCardElement(card, { hidden: !state.gameOver });
    if (state.gameOver) {
      const row = FIXED_SUIT_ROWS[card.suit];
      node.classList.add("final-ai-card");
      node.classList.toggle("covered-card", state.aiHand.some((other) => other.rank === card.rank && FIXED_SUIT_ROWS[other.suit] > row));
      node.style.top = `${row * 40}px`;
      node.style.left = `${(card.rank - 1) * 6.5}%`;
      node.style.zIndex = String(10 + row * 13 + card.rank);
    }
    el["ai-hand"].append(node);
  }
}

function renderSnapshotHand(container, cards) {
  container.replaceChildren();
  const orderedCards = cards.slice().sort((a, b) => FIXED_SUIT_ROWS[a.suit] - FIXED_SUIT_ROWS[b.suit] || a.rank - b.rank);
  for (const card of orderedCards) {
    const node = createCardElement(card);
    const row = FIXED_SUIT_ROWS[card.suit];
    node.classList.add("snapshot-card");
    node.classList.toggle("covered-card", cards.some((other) => other.rank === card.rank && FIXED_SUIT_ROWS[other.suit] > row));
    node.style.top = `${row * 33}px`;
    node.style.left = `${(card.rank - 1) * 7.4}%`;
    node.style.zIndex = String(10 + row * 13 + card.rank);
    container.append(node);
  }
}

function renderPiles() {
  el["stock-count"].textContent = `덱 ${state.deck.length}장`;
  el["stock-pile"].disabled = state.gameOver || state.turn !== "player" || state.phase !== "draw";
  el["discard-pile"].disabled = state.gameOver || state.turn !== "player" || !["draw", "upcard"].includes(state.phase) || !state.discard.length || state.discard.at(-1)?.id === state.blockedInitialDiscardId;
  const top = state.discard.at(-1);
  el["discard-card"].replaceChildren(top ? createCardElement(top) : document.createTextNode("비어 있음"));
}

function renderTurn() {
  const playerTurn = state.turn === "player" && !state.gameOver;
  el["player-status-dot"].classList.toggle("active", playerTurn);
  el["ai-status-dot"].classList.toggle("active", state.turn === "ai" && !state.gameOver);
  el["ai-dealer"].hidden = state.dealer !== "ai";
  el["player-dealer"].hidden = state.dealer !== "player";
  if (state.gameOver) {
    el["turn-kicker"].textContent = "HAND COMPLETE";
    el["turn-message"].textContent = "핸드가 끝났습니다";
    el["turn-detail"].textContent = "AI 복기에서 선택이 갈린 장면을 확인하세요.";
  } else if (state.turn === "ai") {
    el["turn-kicker"].textContent = "AI TURN";
    el["turn-message"].textContent = state.aiAction || "AI가 수를 계산하고 있습니다";
    el["turn-detail"].textContent = "AI 패 수가 11장이 된 뒤 설정한 간격만큼 기다리고 버립니다.";
  } else if (state.phase === "upcard") {
    el["turn-kicker"].textContent = "UPCARD";
    el["turn-message"].textContent = `첫 업카드 ${cardLabel(state.discard.at(-1))}를 가져올까요?`;
    el["turn-detail"].textContent = "버림패를 누르면 가져옵니다. 가져가지 않으면 PASS를 누르세요.";
  } else if (state.phase === "layoff") {
    el["turn-kicker"].textContent = "LAYOFF";
    el["turn-message"].textContent = "AI 노크 후 레이오프를 계산하고 있습니다";
    el["turn-detail"].textContent = "엔진이 가능한 레이오프를 처리한 뒤 점수를 확정합니다.";
  } else if (state.phase === "draw") {
    el["turn-kicker"].textContent = "YOUR TURN";
    el["turn-message"].textContent = "카드를 한 장 가져오세요";
    el["turn-detail"].textContent = "덱 또는 버림패를 선택할 수 있습니다.";
  } else {
    el["turn-kicker"].textContent = "YOUR TURN";
    el["turn-message"].textContent = state.knockArmed ? "노크할 카드를 누르세요" : `현재 ${state.playerHand.length}장 패입니다. 버릴 카드를 바로 누르세요`;
    el["turn-detail"].textContent = state.knockArmed ? "누른 카드를 버리며 노크합니다." : "KNOCK을 누르면 노크할 카드를 고를 수 있습니다.";
  }
}

function renderActions() {
  const canChooseUpcard = state.turn === "player" && state.phase === "upcard" && !state.gameOver;
  const canKnock = state.turn === "player" && state.phase === "discard" && !state.gameOver
    && state.playerHand.some((card) => card.id !== state.forbiddenDiscardId && evaluateHand(state.playerHand.filter((item) => item.id !== card.id)).deadwood <= 10);
  el["ok-action"].disabled = true;
  el["pass-action"].disabled = !canChooseUpcard;
  el["knock-action"].disabled = !canKnock;
  el["knock-action"].classList.toggle("armed", state.knockArmed);
}

function renderSidebar() {
  el["player-score"].textContent = state.playerScore;
  el["ai-score"].textContent = state.aiScore;
  el["hand-number"].textContent = `HAND ${state.handNumber}`;
  const shownDeadwood = state.playerHand.length > 10
    ? bestDiscardOptions(state.playerHand, "player", state.forbiddenDiscardId)[0]?.deadwood
    : evaluateHand(state.playerHand).deadwood;
  el["player-deadwood"].textContent = `데드우드 ${shownDeadwood ?? 0}`;
  el["ai-deadwood"].textContent = state.gameOver ? `데드우드 ${evaluateHand(state.aiHand).deadwood}` : `${state.aiHand.length}장`;
  el["ai-action-status"].textContent = state.aiAction;
  el["game-log"].replaceChildren();
  for (const entry of state.log) {
    const item = document.createElement("li");
    item.textContent = entry.text;
    item.className = entry.who === "you" ? "you" : "";
    el["game-log"].append(item);
  }
  el["game-log"].scrollTop = el["game-log"].scrollHeight;
  el["review-count"].textContent = state.decisions.filter((item) => item.different).length;
}

function renderResult() {
  el["result-overlay"].hidden = !state.gameOver;
  if (!state.gameOver) return;
  const result = state.lastResult;
  const playerWon = result?.winner === "player";
  const matchWinner = state.playerScore >= TARGET_SCORE ? "player" : state.aiScore >= TARGET_SCORE ? "ai" : null;
  const handSummary = result?.winner
    ? `마지막 핸드: ${playerWon ? "당신" : "AI"} +${result.points}점`
    : "마지막 핸드: 무승부";
  const finalScore = `최종 점수: 당신 ${state.playerScore}점 · AI ${state.aiScore}점`;
  el["result-kicker"].textContent = matchWinner ? "MATCH COMPLETE" : "HAND COMPLETE";
  el["result-title"].textContent = matchWinner
    ? `${matchWinner === "player" ? "당신" : "AI"}의 매치 승리`
    : result?.winner
      ? `${playerWon ? "당신" : "AI"} +${result.points}점`
      : "이번 핸드는 무승부";
  el["result-body"].textContent = matchWinner
    ? `${handSummary}\n${result?.reason || ""}\n${finalScore}`
    : result?.reason || "";  el["next-hand"].textContent = matchWinner ? "새 대국" : "다음 핸드";
}

function render() {
  renderHands();
  renderPiles();
  renderTurn();
  renderActions();
  renderSidebar();
  renderResult();
  renderReview();
}

function revealHint() {
  if (state.gameOver || state.turn !== "player") {
    el["live-coach"].textContent = "현재는 추천할 수 있는 내 차례가 아닙니다.";
    return;
  }
  if (state.phase === "draw") {
    const options = estimateDrawOptions(state.playerHand, "player", "strong");
    const best = options[0];
    const runnerUp = options[1];
    el["live-coach"].innerHTML = `<strong>${best.label}</strong><br>${best.reason}${runnerUp ? `<br><span class="muted">다른 선택과 평가 차이 ${formatLoss(best.score - runnerUp.score)}</span>` : ""}`;
    return;
  }
  if (state.phase === "discard") {
    const options = bestDiscardOptions(state.playerHand, "player", state.forbiddenDiscardId);
    const best = options[0];
    el["live-coach"].innerHTML = `<strong>${best.label} 버리기</strong><br>${best.reason}`;
  }
}

function formatLoss(value) {
  return Math.max(0, value).toFixed(1);
}

function persist() {
  const serializable = {
    decisions: state.decisions,
    playerScore: state.playerScore,
    aiScore: state.aiScore,
    handNumber: state.handNumber,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
}

function restoreDecisions() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return Array.isArray(stored?.decisions) ? stored.decisions : [];
  } catch {
    return [];
  }
}

function showView(viewName) {
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === `${viewName}-view`));
  document.querySelectorAll(".tab-button").forEach((button) => button.classList.toggle("active", button.dataset.view === viewName));
  if (viewName === "review") renderReview();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function reviewExplanation(decision) {
  if (!decision.different) {
    return "강한 AI의 1순위와 같은 선택입니다. 결과보다 판단 과정이 좋았던 장면으로 볼 수 있습니다.";
  }
  const recommended = decision.options.find((option) => option.key === decision.recommendedKey) || decision.options[0];
  if (decision.type === "draw") {
    return `${recommended.reason} 숨은 패를 직접 보지 않고, 공개된 카드와 가능한 미지 카드를 기준으로 비교했습니다.`;
  }
  return `${recommended.reason} 평가 손실은 실제 점수 손실이 아니라 패 효율·노크 가능성·상대 위험을 합친 비교 지표입니다.`;
}

function renderReview() {
  const decisions = state.decisions || [];
  const different = decisions.filter((decision) => decision.different);
  const averageLoss = decisions.length ? decisions.reduce((sum, decision) => sum + decision.loss, 0) / decisions.length : 0;
  el["summary-total"].textContent = decisions.length;
  el["summary-different"].textContent = different.length;
  el["summary-loss"].textContent = formatLoss(averageLoss);
  el["summary-agreement"].textContent = decisions.length ? `${Math.round(((decisions.length - different.length) / decisions.length) * 100)}%` : "—";

  const visible = el["difference-only"].checked ? different : decisions;
  el["decision-list-count"].textContent = `${visible.length}개`;
  el["decision-list"].replaceChildren();
  if (visible.length && !visible.some((decision) => decision.id === selectedDecisionId)) selectedDecisionId = visible.at(-1).id;
  for (const decision of visible.slice().reverse()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `decision-row${decision.id === selectedDecisionId ? " active" : ""}`;
    button.innerHTML = `
      <span class="decision-row-top">
        <strong>${decision.type === "draw" ? "드로우 선택" : "버림 선택"}</strong>
        <span class="decision-badge${decision.different ? " different" : ""}">${decision.different ? "차이" : "일치"}</span>
      </span>
      <span class="decision-row-bottom">
        <span>H${decision.handNumber} · #${decision.turnNumber}</span>
        <span>${decision.actualLabel}</span>
      </span>`;
    button.addEventListener("click", () => {
      selectedDecisionId = decision.id;
      renderReview();
    });
    el["decision-list"].append(button);
  }

  const decision = decisions.find((item) => item.id === selectedDecisionId) || visible.at(-1);
  if (!decision) {
    el["review-detail"].innerHTML = `
      <div class="empty-review">
        <span class="empty-icon">♠</span>
        <h2>${decisions.length ? "조건에 맞는 장면이 없습니다" : "아직 복기할 선택이 없습니다"}</h2>
        <p>${decisions.length ? "필터를 해제하면 AI와 일치한 선택도 볼 수 있습니다." : "한 수를 두면 AI의 추천과 비교한 기록이 여기에 쌓입니다."}</p>
        <button class="primary-button" data-go-game>대국으로 돌아가기</button>
      </div>`;
    el["review-detail"].querySelector("[data-go-game]")?.addEventListener("click", () => showView("game"));
    return;
  }

  const scores = decision.options.map((option) => option.score);
  const maximum = Math.max(...scores);
  const minimum = Math.min(...scores);
  const range = Math.max(1, maximum - minimum);
  el["review-detail"].innerHTML = `
    <div class="review-title-row">
      <div>
        <span class="eyebrow">HAND ${decision.handNumber} · DECISION ${decision.turnNumber}</span>
        <h2>${decision.type === "draw" ? "어디서 가져올까?" : "무엇을 버릴까?"}</h2>
        <p>${decision.different ? "AI의 1순위와 다른 선택입니다." : "강한 AI와 같은 선택입니다."}</p>
      </div>
      <span class="loss-chip">평가 손실 ${formatLoss(decision.loss)}</span>
    </div>
    <div class="snapshot">
      <span class="snapshot-label">선택 당시 내 패</span>
      <div class="hand snapshot-hand" id="snapshot-hand"></div>
    </div>
    <div class="choice-comparison">
      <div class="choice-card">
        <span>내 선택</span>
        <strong>${decision.actualLabel}</strong>
      </div>
      <div class="choice-card recommended">
        <span>강한 AI 추천</span>
        <strong>${decision.recommendedLabel}</strong>
      </div>
    </div>
    <div class="option-list">
      ${decision.options.map((option, index) => {
        const width = 24 + ((option.score - minimum) / range) * 76;
        const rating = Math.max(0, 100 - (maximum - option.score));
        return `<div class="option-row"><span>${index + 1}위 ${option.label}</span><div class="option-track"><i style="width:${width}%"></i></div><b>${rating.toFixed(1)}</b></div>`;
      }).join("")}
    </div>
    <div class="analysis-note">${reviewExplanation(decision)}</div>`;
  renderSnapshotHand(document.getElementById("snapshot-hand"), decision.hand);
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  el.toast.textContent = message;
  el.toast.classList.add("show");
  toastTimer = window.setTimeout(() => el.toast.classList.remove("show"), 2600);
}

function publicGameState() {
  return {
    turn: state.turn,
    phase: state.phase,
    playerHand: sortCards(state.playerHand).map((card) => ({ id: card.id, label: cardLabel(card) })),
    aiCardCount: state.aiHand.length,
    topDiscard: state.discard.length ? { id: state.discard.at(-1).id, label: cardLabel(state.discard.at(-1)) } : null,
    stockCount: state.deck.length,
    scores: { player: state.playerScore, ai: state.aiScore },
    handNumber: state.handNumber,
    gameOver: state.gameOver,
  };
}

function registerWebMCP() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const register = (tool) => {
    try {
      void Promise.resolve(context.registerTool(tool)).catch(() => {});
    } catch {
      // WebMCP is optional and must never block the game UI.
    }
  };
  register({
    name: "read_game_state",
    title: "Read gin rummy game state",
    description: "Read the visible player hand, discard, turn, phase, stock count, and score without revealing the AI hand.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: false },
    execute() {
      return publicGameState();
    },
  });
  register({
    name: "draw_card",
    title: "Draw a card",
    description: "On the player's draw phase, draw from the stock or take the visible discard.",
    inputSchema: {
      type: "object",
      properties: { source: { type: "string", enum: ["stock", "discard"] } },
      required: ["source"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    execute(input) {
      if (!input || !["stock", "discard"].includes(input.source)) throw new Error("source must be stock or discard");
      if (state.turn !== "player" || state.phase !== "draw" || state.gameOver) throw new Error("It is not the player's draw phase");
      drawPlayer(input.source);
      return publicGameState();
    },
  });
  register({
    name: "discard_card",
    title: "Discard a card",
    description: "On the player's discard phase, discard one card and optionally knock when the resulting deadwood is 10 or less.",
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string" },
        knock: { type: "boolean", default: false },
      },
      required: ["cardId", "knock"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    execute(input) {
      if (!input || typeof input.cardId !== "string" || typeof input.knock !== "boolean") throw new Error("cardId and knock are required");
      if (state.turn !== "player" || state.phase !== "discard" || state.gameOver) throw new Error("It is not the player's discard phase");
      const card = state.playerHand.find((candidate) => candidate.id === input.cardId);
      if (!card) throw new Error("The requested card is not in the player's hand");
      if (card.id === state.forbiddenDiscardId) throw new Error("The just-taken discard cannot be discarded immediately");
      state.selectedCardId = card.id;
      playerDiscard(input.knock);
      return publicGameState();
    },
  });
}

el["stock-pile"].addEventListener("click", () => drawPlayer("stock"));
el["discard-pile"].addEventListener("click", () => drawPlayer("discard"));
el["ok-action"].addEventListener("click", () => drawPlayer("discard"));
el["pass-action"].addEventListener("click", playerPassUpcard);
el["knock-action"].addEventListener("click", armKnock);
el["hint-button"].addEventListener("click", revealHint);
el["new-match"].addEventListener("click", startMatch);
el["brand-button"].addEventListener("click", () => showView("game"));
el["open-review"].addEventListener("click", () => showView("review"));
el["next-hand"].addEventListener("click", () => {
  if (state.lastResult?.matchOver) startMatch();
  else if (usingEngine()) startEngineHand(true);
  else startHand();
});
el["difference-only"].addEventListener("change", renderReview);
document.querySelectorAll(".tab-button").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
document.querySelectorAll("[data-go-game]").forEach((button) => button.addEventListener("click", () => showView("game")));

const restored = restoreDecisions();
fitTableToViewport();
window.addEventListener("resize", fitTableToViewport);
state = freshState();
state.decisions = restored;
state.decisionCounter = restored.reduce((max, decision) => Math.max(max, decision.id || 0), 0);
if (usingEngine()) {
  state.turn = "ai";
  state.phase = "thinking";
  state.aiAction = "Engine loading";
  render();
} else {
  startHand();
}
registerWebMCP();
loadEngine();
el.difficulty.addEventListener("change", startMatch);
