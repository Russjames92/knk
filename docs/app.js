import { createNewGameState } from "./engine/state.js";
import { serverAdvanceDrawPhase, getLegalIntents, applyIntentStrict } from "./engine/rules.js";

const elStatus = document.getElementById("status");
const elInfo = document.getElementById("info");
const elBoard = document.getElementById("board");
const elHand = document.getElementById("hand");
const elLog = document.getElementById("log");
const elPhasePill = document.getElementById("phasePill");
const elTurnPill = document.getElementById("turnPill");
const elCheckPill = document.getElementById("checkPill");
const elHint = document.getElementById("hint");

const btnNew = document.getElementById("btnNew");
const btnReset = document.getElementById("btnReset");
const aiToggle = document.getElementById("aiToggle");

const btnPlaySingle = document.getElementById("btnPlaySingle");
const btnPlayCombo = document.getElementById("btnPlayCombo");
const btnClear = document.getElementById("btnClear");
const btnConfirm = document.getElementById("btnConfirm");
const btnEndTurn = document.getElementById("btnEndTurn");

let state = null;

// CARD PICKING (pre-lock)
let selectedCards = [];

// LOCKED PLAY (after clicking Play Single/Combo)
let lockedPlay = null; // { type:"SINGLE"|"COMBO", cardIds:[...], side:"W"|"B" }

// BOARD selection builder state
let builder = null;
/**
 builder shapes:
 - null
 - { mode:"GENERIC", pieceId:null|id, to:null|sq }   // most intents
 - { mode:"NN_DOUBLE", pieceId:null|id, to1:null|sq, to2:null|sq }
 - { mode:"NN_SPLIT", aId:null|id, aTo:null|sq, bId:null|id, bTo:null|sq }
 - { mode:"ROOK_SWAP", aId:null|id, bId:null|id }
 - { mode:"BISHOP_BLOCK", kingTo:null|sq } // minimal (we’ll upgrade later)
*/

let pendingIntent = null;

function isAIEnabled() { return !!aiToggle.checked; }
function controllingSide() {
  if (isAIEnabled()) return "W";
  if (state.phase.stage === "SETUP") return state.phase.setup.sideToPlace;
  return state.phase.turn.side;
}

btnNew.onclick = () => startNewGame();
btnReset.onclick = () => startNewGame();

btnClear.onclick = () => {
  selectedCards = [];
  lockedPlay = null;
  builder = null;
  pendingIntent = null;
  render();
};

btnPlaySingle.onclick = () => {
  if (selectedCards.length !== 1) return;
  lockedPlay = { type: "SINGLE", cardIds: [...selectedCards], side: controllingSide() };
  builder = inferBuilderMode();
  pendingIntent = null;
  render();
};

btnPlayCombo.onclick = () => {
  if (selectedCards.length !== 2) return;
  lockedPlay = { type: "COMBO", cardIds: [...selectedCards], side: controllingSide() };
  builder = inferBuilderMode();
  pendingIntent = null;
  render();
};

btnConfirm.onclick = () => {
  if (!pendingIntent) return;
  stepApply(pendingIntent);
};

btnEndTurn.onclick = () => {
  lockedPlay = null;
  builder = null;
  pendingIntent = null;
  render();
};

function startNewGame() {
  state = createNewGameState({ vsAI: isAIEnabled(), aiSide: "B" });
  elStatus.textContent = "Offline (GitHub Pages)";
  selectedCards = [];
  lockedPlay = null;
  builder = null;
  pendingIntent = null;
  tick();
  render();
}

/* ---------------- AI ---------------- */

function tick() {
  state = serverAdvanceDrawPhase(state);

  while (state.result.status === "ONGOING" && state.phase.stage === "TURN" && state.phase.turn.step === "PLAY") {
    const side = state.phase.turn.side;

    if (side === "B" && isAIEnabled()) {
      const legal = getLegalIntents(state, "B");
      if (legal.length === 0) break;

      // Always take immediate king capture
      const win = legal.find((it) => isImmediateKingCapture(state, it));
      const choice = win || chooseBestAIIntent(state, "B", 2); // minimax depth 2

      state = applyIntentStrict(state, choice);
      state = serverAdvanceDrawPhase(state);
      continue;
    }
    break;
  }
}

function isImmediateKingCapture(st, intent) {
  const a = intent?.action;
  const to = a?.payload?.to;
  if (!to) return false;
  const pid = st.board?.[to];
  if (!pid) return false;
  const p = st.pieces?.[pid];
  return p && p.type === "K" && p.side !== intent.side;
}

function chooseBestAIIntent(st, side, depth) {
  const legal = getLegalIntents(st, side);
  if (legal.length === 0) return legal[0];

  // quick pre-score to limit branching
  const scored = legal.map((it) => {
    let next;
    try { next = applyIntentStrict(st, it); } catch { next = null; }
    const s = next ? evaluateState(next, side) : -999999;
    return { it, s };
  }).sort((a,b)=> b.s - a.s);

  const top = scored.slice(0, 24); // cap branching

  // minimax
  let best = top[0]?.it || legal[0];
  let bestScore = -Infinity;

  for (const { it } of top) {
    let next;
    try { next = applyIntentStrict(st, it); } catch { continue; }

    if (next.result.status === "WIN" && next.result.winner === side) {
      return it; // forced win
    }

    const score = minimax(next, otherSide(side), side, depth - 1);
    if (score > bestScore) {
      bestScore = score;
      best = it;
    }
  }
  return best;
}

function minimax(st, toMove, maximizingSide, depth) {
  // terminal
  if (st.result.status !== "ONGOING") {
    if (st.result.winner === maximizingSide) return 999999;
    return -999999;
  }
  if (depth <= 0) return evaluateState(st, maximizingSide);

  const legal = getLegalIntents(st, toMove);
  if (legal.length === 0) {
    // no legal plays — evaluation handles checkmate-like outcomes via result in rules,
    // but if it slips through, treat as bad for toMove
    return evaluateState(st, maximizingSide);
  }

  // prioritize king captures at all depths
  const win = legal.find((it) => isImmediateKingCapture(st, it));
  if (win) {
    const next = applyIntentStrict(st, win);
    return minimax(next, otherSide(toMove), maximizingSide, depth - 1);
  }

  const isMax = (toMove === maximizingSide);
  let best = isMax ? -Infinity : Infinity;

  // limit branching
  const quick = legal.slice(0, 28);

  for (const it of quick) {
    let next;
    try { next = applyIntentStrict(st, it); } catch { continue; }
    const val = minimax(next, otherSide(toMove), maximizingSide, depth - 1);
    if (isMax) best = Math.max(best, val);
    else best = Math.min(best, val);
  }
  return best;
}

function otherSide(s){ return s === "W" ? "B" : "W"; }

function evaluateState(st, povSide) {
  // big win/loss handled in minimax terminal, but keep safe
  if (st.result.status !== "ONGOING") {
    if (st.result.winner === povSide) return 999999;
    return -999999;
  }

  const val = { K: 10000, Q: 900, R: 500, B: 330, N: 320, P: 100 };

  let w = 0, b = 0;
  for (const p of Object.values(st.pieces)) {
    if (p.status !== "ACTIVE") continue;
    const v = val[p.type] || 0;
    if (p.side === "W") w += v; else b += v;
  }

  let score = (povSide === "W" ? (w - b) : (b - w));

  // check pressure
  const opp = otherSide(povSide);
  if (st.threat?.inCheck?.[opp]) score += 120;
  if (st.threat?.inCheck?.[povSide]) score -= 200;

  // small mobility bonus (avoid freezing)
  try {
    const myMoves = getLegalIntents(st, povSide).length;
    const oppMoves = getLegalIntents(st, opp).length;
    score += Math.max(-50, Math.min(50, myMoves - oppMoves));
  } catch {}

  return score;
}

/* ---------------- Apply + render ---------------- */

function stepApply(intent) {
  state = applyIntentStrict(state, intent);

  // reset planning UI after action
  selectedCards = [];
  lockedPlay = null;
  builder = null;
  pendingIntent = null;

  tick();
  render();
}

function render() {
  if (!state) return;

  elPhasePill.textContent = `Stage: ${state.phase.stage}`;
  if (state.phase.stage === "SETUP") {
    elTurnPill.textContent = `Setup: ${state.phase.setup.sideToPlace} / ${state.phase.setup.step}`;
  } else {
    elTurnPill.textContent = `Turn: ${state.phase.turn.side} / ${state.phase.turn.step}`;
  }
  elCheckPill.textContent = `Check: W=${!!state.threat?.inCheck?.W} B=${!!state.threat?.inCheck?.B}`;

  elInfo.textContent = JSON.stringify(
    { result: state.result, phase: state.phase, hand: { W: state.cards.W.hand.length, B: state.cards.B.hand.length } },
    null,
    2
  );

  renderHand();
  renderBoard();
  renderLog();
  renderHintAndButtons();
}

function renderHintAndButtons() {
  btnPlaySingle.disabled = true;
  btnPlayCombo.disabled = true;
  btnClear.disabled = false;
  btnConfirm.disabled = !pendingIntent;
  btnEndTurn.disabled = false;

  if (state.result.status !== "ONGOING") {
    elHint.textContent = `Game Over — Winner: ${state.result.winner} (${state.result.reason})`;
    btnConfirm.disabled = true;
    return;
  }

  if (state.phase.stage === "SETUP") {
    const side = state.phase.setup.sideToPlace;
    const step = state.phase.setup.step;
    elHint.textContent =
      step === "PLACE_KING"
        ? `${side}: Place your King on the back rank (not a corner). Click a square.`
        : `${side}: Place your Knights adjacent to your King (left/right). Click either adjacent square.`;
    return;
  }

  if (state.phase.turn.step !== "PLAY") {
    elHint.textContent = "Drawing...";
    return;
  }

  // TURN / PLAY
  if (!lockedPlay) {
    elHint.textContent = "Select cards, then click Play Single or Play Combo to lock your action.";
    if (selectedCards.length === 1) btnPlaySingle.disabled = false;
    if (selectedCards.length === 2) btnPlayCombo.disabled = false;
    return;
  }

  // Locked: show minimal guidance without hints
  if (!builder) builder = inferBuilderMode();

  if (builder.mode === "NN_DOUBLE") {
    const a = builder;
    if (!a.pieceId) elHint.textContent = "NN DOUBLE: Click a knight to move twice.";
    else if (!a.to1) elHint.textContent = "NN DOUBLE: Click first destination.";
    else if (!a.to2) elHint.textContent = "NN DOUBLE: Click second destination.";
    else elHint.textContent = pendingIntent ? "Legal selection. Click Confirm." : "Not legal for these cards.";
    return;
  }

  if (builder.mode === "NN_SPLIT") {
    const a = builder;
    if (!a.aId) elHint.textContent = "NN SPLIT: Click first knight.";
    else if (!a.aTo) elHint.textContent = "NN SPLIT: Click destination for first knight.";
    else if (!a.bId) elHint.textContent = "NN SPLIT: Click second knight.";
    else if (!a.bTo) elHint.textContent = "NN SPLIT: Click destination for second knight.";
    else elHint.textContent = pendingIntent ? "Legal selection. Click Confirm." : "Not legal for these cards.";
    return;
  }

  if (builder.mode === "ROOK_SWAP") {
    const a = builder;
    if (!a.aId) elHint.textContent = "Rook Noble: Click first non-pawn piece to swap.";
    else if (!a.bId) elHint.textContent = "Rook Noble: Click second non-pawn piece to swap.";
    else elHint.textContent = pendingIntent ? "Legal selection. Click Confirm." : "Not legal for these cards.";
    return;
  }

  elHint.textContent = pendingIntent
    ? "Legal selection. Click Confirm."
    : "Cards locked. Click a piece (or square) then click a destination square.";
}

function renderHand() {
  elHand.innerHTML = "";
  const side = controllingSide();
  const hand = state.cards?.[side]?.hand || [];
  const locked = !!lockedPlay;

  for (const cid of hand) {
    const c = state.cardInstances[cid];
    const div = document.createElement("div");
    div.className = "card" + (selectedCards.includes(cid) ? " selected" : "");
    div.textContent = c.kind;

    div.onclick = () => {
      if (locked) return;
      if (selectedCards.includes(cid)) selectedCards = selectedCards.filter((x) => x !== cid);
      else {
        if (selectedCards.length >= 2) return;
        selectedCards = [...selectedCards, cid];
      }
      render();
    };

    elHand.appendChild(div);
  }
}

function renderBoard() {
  elBoard.innerHTML = "";

  const files = ["a","b","c","d","e","f","g","h"];
  const selSquares = new Set();

  // show only what the player clicked (no legal hints)
  if (builder?.mode === "NN_DOUBLE") {
    if (builder.pieceId) selSquares.add(state.pieces[builder.pieceId]?.square);
    if (builder.to1) selSquares.add(builder.to1);
    if (builder.to2) selSquares.add(builder.to2);
  } else if (builder?.mode === "NN_SPLIT") {
    if (builder.aId) selSquares.add(state.pieces[builder.aId]?.square);
    if (builder.aTo) selSquares.add(builder.aTo);
    if (builder.bId) selSquares.add(state.pieces[builder.bId]?.square);
    if (builder.bTo) selSquares.add(builder.bTo);
  } else if (builder?.mode === "ROOK_SWAP") {
    if (builder.aId) selSquares.add(state.pieces[builder.aId]?.square);
    if (builder.bId) selSquares.add(state.pieces[builder.bId]?.square);
  } else if (builder?.mode === "GENERIC") {
    if (builder.pieceId) selSquares.add(state.pieces[builder.pieceId]?.square);
    if (builder.to) selSquares.add(builder.to);
  }

  for (let r=8;r>=1;r--) {
    for (let f=0;f<8;f++) {
      const square = `${files[f]}${r}`;
      const isDark = (f + r) % 2 === 0;

      const div = document.createElement("div");
      const classes = ["square", isDark ? "dark":"light"];
      if (selSquares.has(square)) classes.push("selected");
      div.className = classes.join(" ");

      const pid = state.board?.[square];
      if (pid) {
        const p = state.pieces[pid];
        const chip = document.createElement("div");
        chip.className = "piece";
        chip.textContent = `${p.side}${p.type}`;
        div.appendChild(chip);
      }

      div.onclick = () => onSquareClick(square);
      elBoard.appendChild(div);
    }
  }
}

function onSquareClick(square) {
  if (state.result.status !== "ONGOING") return;

  if (state.phase.stage === "SETUP") {
    handleSetupClick(square);
    return;
  }

  if (!(state.phase.stage === "TURN" && state.phase.turn.step === "PLAY")) return;
  if (isAIEnabled() && state.phase.turn.side !== "W") return;
  if (!lockedPlay) return;

  if (!builder) builder = inferBuilderMode();

  const side = lockedPlay.side;
  const clickedPid = state.board?.[square] || null;
  const clickedPiece = clickedPid ? state.pieces[clickedPid] : null;

  // helper
  const isMyActivePiece = (pid) => {
    const p = pid ? state.pieces[pid] : null;
    return !!(p && p.side === side && p.status === "ACTIVE");
  };
  const isMyActiveKnight = (pid) => {
    const p = pid ? state.pieces[pid] : null;
    return !!(p && p.side === side && p.status === "ACTIVE" && p.type === "N");
  };
  const isMyActiveNonPawn = (pid) => {
    const p = pid ? state.pieces[pid] : null;
    return !!(p && p.side === side && p.status === "ACTIVE" && p.type !== "P");
  };

  // NN DOUBLE builder
  if (builder.mode === "NN_DOUBLE") {
    if (!builder.pieceId) {
      if (isMyActiveKnight(clickedPid)) {
        builder.pieceId = clickedPid;
        builder.to1 = null; builder.to2 = null;
      }
    } else if (!builder.to1) {
      builder.to1 = square;
    } else if (!builder.to2) {
      builder.to2 = square;
    } else {
      // if user clicks again, restart to2 as last click
      builder.to2 = square;
    }
    pendingIntent = findPendingFromBuilder();
    render();
    return;
  }

  // NN SPLIT builder
  if (builder.mode === "NN_SPLIT") {
    if (!builder.aId) {
      if (isMyActiveKnight(clickedPid)) {
        builder.aId = clickedPid;
        builder.aTo = null; builder.bId = null; builder.bTo = null;
      }
    } else if (!builder.aTo) {
      builder.aTo = square;
    } else if (!builder.bId) {
      if (isMyActiveKnight(clickedPid) && clickedPid !== builder.aId) {
        builder.bId = clickedPid;
        builder.bTo = null;
      }
    } else if (!builder.bTo) {
      builder.bTo = square;
    } else {
      builder.bTo = square;
    }
    pendingIntent = findPendingFromBuilder();
    render();
    return;
  }

  // Rook swap builder
  if (builder.mode === "ROOK_SWAP") {
    if (!builder.aId) {
      if (isMyActiveNonPawn(clickedPid)) builder.aId = clickedPid;
    } else if (!builder.bId) {
      if (isMyActiveNonPawn(clickedPid) && clickedPid !== builder.aId) builder.bId = clickedPid;
    } else {
      // reset to new first selection
      builder.aId = (isMyActiveNonPawn(clickedPid) ? clickedPid : builder.aId);
      builder.bId = null;
    }
    pendingIntent = findPendingFromBuilder();
    render();
    return;
  }

  // Generic builder (most actions)
  if (builder.mode === "GENERIC") {
    if (!builder.pieceId) {
      if (isMyActivePiece(clickedPid)) builder.pieceId = clickedPid;
      else builder.to = square; // allow PLACE etc.
    } else if (!builder.to) {
      builder.to = square;
    } else {
      builder.to = square;
    }
    pendingIntent = findPendingFromBuilder();
    render();
    return;
  }
}

/* ---------------- Setup clicks ---------------- */

function handleSetupClick(square) {
  const side = state.phase.setup.sideToPlace;
  const step = state.phase.setup.step;

  if (step === "PLACE_KING") {
    const intent = { kind:"SETUP", side, action:{ type:"SETUP_PLACE_KING", payload:{ to: square } } };
    try { state = applyIntentStrict(state, intent); tick(); render(); } catch {}
    return;
  }

  if (step === "PLACE_KNIGHTS") {
    const kid = `${side}_K`;
    const ksq = state.pieces[kid]?.square;
    if (!ksq) return;
    const left = String.fromCharCode(ksq.charCodeAt(0) - 1) + ksq[1];
    const right = String.fromCharCode(ksq.charCodeAt(0) + 1) + ksq[1];
    if (square !== left && square !== right) return;

    const intent = { kind:"SETUP", side, action:{ type:"SETUP_PLACE_KNIGHTS", payload:{ left, right } } };
    try { state = applyIntentStrict(state, intent); tick(); render(); } catch {}
  }
}

/* ---------------- Builder inference + intent matching ---------------- */

function inferBuilderMode() {
  // If not locked, no builder
  if (!lockedPlay) return null;

  const side = lockedPlay.side;
  const legal = getLegalIntents(state, side);
  const want = new Set(lockedPlay.cardIds);

  const candidates = legal.filter((it) => {
    const ids = it.play?.cardIds || [];
    if (ids.length !== want.size) return false;
    for (const id of ids) if (!want.has(id)) return false;
    return true;
  });

  // If rook swap exists in candidates -> use rook swap builder
  if (candidates.some((it) => it.action?.type === "NOBLE_ROOK_SWAP")) {
    return { mode: "ROOK_SWAP", aId: null, bId: null };
  }

  // If NN combo exists, decide between DOUBLE/SPLIT builder
  const nn = candidates.filter((it) => it.action?.type === "COMBO_NN");
  if (nn.length) {
    // if any split exists, allow split builder (hardest case)
    if (nn.some((it) => it.action.payload?.mode === "SPLIT")) {
      return { mode: "NN_SPLIT", aId: null, aTo: null, bId: null, bTo: null };
    }
    // else double
    return { mode: "NN_DOUBLE", pieceId: null, to1: null, to2: null };
  }

  // default generic
  return { mode: "GENERIC", pieceId: null, to: null };
}

function findPendingFromBuilder() {
  const side = lockedPlay.side;
  const legal = getLegalIntents(state, side);
  const want = new Set(lockedPlay.cardIds);

  const candidates = legal.filter((it) => {
    const ids = it.play?.cardIds || [];
    if (ids.length !== want.size) return false;
    for (const id of ids) if (!want.has(id)) return false;
    return true;
  });

  // NN DOUBLE exact match
  if (builder.mode === "NN_DOUBLE") {
    const { pieceId, to1, to2 } = builder;
    if (!pieceId || !to1 || !to2) return null;
    return candidates.find((it) => {
      const a = it.action;
      if (a.type !== "COMBO_NN") return false;
      if (a.payload.mode !== "DOUBLE") return false;
      if (a.payload.double.pieceId !== pieceId) return false;
      const m = a.payload.double.moves;
      return m?.[0]?.to === to1 && m?.[1]?.to === to2;
    }) || null;
  }

  // NN SPLIT exact match (order-insensitive)
  if (builder.mode === "NN_SPLIT") {
    const { aId, aTo, bId, bTo } = builder;
    if (!aId || !aTo || !bId || !bTo) return null;

    return candidates.find((it) => {
      const a = it.action;
      if (a.type !== "COMBO_NN") return false;
      if (a.payload.mode !== "SPLIT") return false;

      const A = a.payload.split.a;
      const B = a.payload.split.b;

      const direct =
        A.pieceId === aId && A.to === aTo &&
        B.pieceId === bId && B.to === bTo;

      const swapped =
        A.pieceId === bId && A.to === bTo &&
        B.pieceId === aId && B.to === aTo;

      return direct || swapped;
    }) || null;
  }

  // Rook swap match
  if (builder.mode === "ROOK_SWAP") {
    const { aId, bId } = builder;
    if (!aId || !bId) return null;
    return candidates.find((it) => {
      const a = it.action;
      if (a.type !== "NOBLE_ROOK_SWAP") return false;
      const x = a.payload.pieceA, y = a.payload.pieceB;
      return (x === aId && y === bId) || (x === bId && y === aId);
    }) || null;
  }

  // Generic match
  if (builder.mode === "GENERIC") {
    const { pieceId, to } = builder;
    if (!to) return null;

    for (const it of candidates) {
      const a = it.action;
      const p = a.payload || {};
      if (p.to !== to) continue;

      // if a pieceId is required, match it; if we haven't selected pieceId,
      // allow PLACE / resurrect that doesn't rely on active-piece selection.
      if (p.pieceId) {
        if (pieceId && p.pieceId === pieceId) return it;
        // allow if user didn’t click a piece but intent doesn’t really need a specific active piece (rare)
        continue;
      }
      return it;
    }
    return null;
  }

  return null;
}

/* ---------------- Log ---------------- */

function renderLog() {
  elLog.innerHTML = "";
  (state.log || []).slice(-30).forEach((e) => {
    const row = document.createElement("div");
    row.textContent = e.summary;
    elLog.appendChild(row);
  });
}

// boot
startNewGame();
