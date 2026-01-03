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

// BOARD SELECTION (only after lockedPlay)
let selectedPieceId = null; // piece being used for move-like actions
let selectedToSquare = null; // destination square OR second click for rook swap etc.
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
  selectedPieceId = null;
  selectedToSquare = null;
  pendingIntent = null;
  render();
};

btnPlaySingle.onclick = () => {
  if (selectedCards.length !== 1) return;
  lockedPlay = { type: "SINGLE", cardIds: [...selectedCards], side: controllingSide() };
  // clear board selections
  selectedPieceId = null;
  selectedToSquare = null;
  pendingIntent = null;
  render();
};

btnPlayCombo.onclick = () => {
  if (selectedCards.length !== 2) return;
  lockedPlay = { type: "COMBO", cardIds: [...selectedCards], side: controllingSide() };
  selectedPieceId = null;
  selectedToSquare = null;
  pendingIntent = null;
  render();
};

btnConfirm.onclick = () => {
  if (!pendingIntent) return;
  stepApply(pendingIntent);
};

btnEndTurn.onclick = () => {
  // you can keep this as "cancel current planning"
  lockedPlay = null;
  selectedPieceId = null;
  selectedToSquare = null;
  pendingIntent = null;
  render();
};

function startNewGame() {
  state = createNewGameState({ vsAI: isAIEnabled(), aiSide: "B" });
  elStatus.textContent = "Offline (GitHub Pages)";
  selectedCards = [];
  lockedPlay = null;
  selectedPieceId = null;
  selectedToSquare = null;
  pendingIntent = null;
  tick();
  render();
}

function tick() {
  state = serverAdvanceDrawPhase(state);

  // AI plays as Black (if enabled), with king-capture priority
  while (state.result.status === "ONGOING" && state.phase.stage === "TURN" && state.phase.turn.step === "PLAY") {
    const side = state.phase.turn.side;

    if (side === "B" && isAIEnabled()) {
      const legal = getLegalIntents(state, "B");
      if (legal.length === 0) break;

      // 1) If any legal intent captures the enemy king, take it immediately
      const win = legal.find((it) => isImmediateKingCapture(state, it));
      const choice = win || legal[Math.floor(Math.random() * legal.length)];

      state = applyIntentStrict(state, choice);
      state = serverAdvanceDrawPhase(state);
      continue;
    }
    break;
  }
}

function isImmediateKingCapture(state, intent) {
  const a = intent?.action;
  const to = a?.payload?.to;
  if (!to) return false;
  const pid = state.board?.[to];
  if (!pid) return false;
  const p = state.pieces?.[pid];
  return p && p.type === "K" && p.side !== intent.side;
}

function stepApply(intent) {
  state = applyIntentStrict(state, intent);

  // reset planning UI after action
  selectedCards = [];
  lockedPlay = null;
  selectedPieceId = null;
  selectedToSquare = null;
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
    {
      result: state.result,
      phase: state.phase,
      hand: { W: state.cards.W.hand.length, B: state.cards.B.hand.length }
    },
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
  } else {
    if (!selectedPieceId) {
      elHint.textContent = "Cards locked. Now click a piece to use for this action.";
    } else if (!selectedToSquare) {
      elHint.textContent = "Piece selected. Now click a destination square (no hints shown).";
    } else {
      elHint.textContent = pendingIntent ? "Legal move selected. Click Confirm." : "That selection isn't legal for the locked cards.";
    }
  }
}

function renderHand() {
  elHand.innerHTML = "";
  const side = controllingSide();
  const hand = state.cards?.[side]?.hand || [];

  const handLocked = !!lockedPlay; // cannot change cards after locking

  for (const cid of hand) {
    const c = state.cardInstances[cid];
    const div = document.createElement("div");
    div.className = "card" + (selectedCards.includes(cid) ? " selected" : "");
    div.textContent = c.kind;

    div.onclick = () => {
      if (handLocked) return;

      if (selectedCards.includes(cid)) {
        selectedCards = selectedCards.filter((x) => x !== cid);
      } else {
        if (selectedCards.length >= 2) return;
        selectedCards = [...selectedCards, cid];
      }
      pendingIntent = null;
      render();
    };

    elHand.appendChild(div);
  }
}

function renderBoard() {
  elBoard.innerHTML = "";

  const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
  for (let r = 8; r >= 1; r--) {
    for (let f = 0; f < 8; f++) {
      const square = `${files[f]}${r}`;
      const isDark = (f + r) % 2 === 0;

      const div = document.createElement("div");
      const classes = ["square", isDark ? "dark" : "light"];

      // Only show selection styling, never legal hints
      if (selectedToSquare === square) classes.push("selected");
      if (selectedPieceId && state.pieces[selectedPieceId]?.square === square) classes.push("selected");

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

  // Setup clicks ignore lockedPlay
  if (state.phase.stage === "SETUP") {
    handleSetupClick(square);
    return;
  }

  // Must be your PLAY step
  if (!(state.phase.stage === "TURN" && state.phase.turn.step === "PLAY")) return;

  // If vs AI, only White controls
  if (isAIEnabled() && state.phase.turn.side !== "W") return;

  // Must lock cards first
  if (!lockedPlay) return;

  const side = lockedPlay.side;

  // Step 1: choose a piece (must be yours and active) OR choose square for "place" actions
  // We'll allow clicking either:
  // - a square with your piece => selects piece
  // - an empty square (or any square) => treated as destination attempt (useful for PLACE)
  const clickedPid = state.board?.[square];

  if (!selectedPieceId) {
    // If they clicked one of their pieces, select it
    if (clickedPid) {
      const p = state.pieces[clickedPid];
      if (p && p.side === side && p.status === "ACTIVE") {
        selectedPieceId = clickedPid;
        selectedToSquare = null;
        pendingIntent = null;
        render();
        return;
      }
    }

    // Otherwise treat as "to square" (for PLACE moves, resurrection, etc.)
    selectedToSquare = square;
    pendingIntent = findMatchingIntent();
    render();
    return;
  }

  // Step 2: choose destination
  selectedToSquare = square;
  pendingIntent = findMatchingIntent();
  render();
}

function handleSetupClick(square) {
  const side = state.phase.setup.sideToPlace;
  const step = state.phase.setup.step;

  if (step === "PLACE_KING") {
    const intent = {
      kind: "SETUP",
      side,
      action: { type: "SETUP_PLACE_KING", payload: { to: square } }
    };
    try {
      state = applyIntentStrict(state, intent);
      tick();
      render();
    } catch {
      // illegal, ignore
    }
    return;
  }

  if (step === "PLACE_KNIGHTS") {
    // Only one intent exists; clicking either left or right should work
    const kid = `${side}_K`;
    const ksq = state.pieces[kid]?.square;
    if (!ksq) return;
    const left = String.fromCharCode(ksq.charCodeAt(0) - 1) + ksq[1];
    const right = String.fromCharCode(ksq.charCodeAt(0) + 1) + ksq[1];
    if (square !== left && square !== right) return;

    const intent = {
      kind: "SETUP",
      side,
      action: { type: "SETUP_PLACE_KNIGHTS", payload: { left, right } }
    };
    try {
      state = applyIntentStrict(state, intent);
      tick();
      render();
    } catch {
      // illegal, ignore
    }
  }
}

function findMatchingIntent() {
  const side = lockedPlay.side;
  const legal = getLegalIntents(state, side);

  // Must match card set exactly
  const want = new Set(lockedPlay.cardIds);
  const candidates = legal.filter((it) => {
    const ids = it.play?.cardIds || [];
    if (ids.length !== want.size) return false;
    for (const id of ids) if (!want.has(id)) return false;
    return true;
  });

  // Now match the player’s piece+to selection against intent shape
  for (const it of candidates) {
    const a = it.action;

    // Common "to" actions: PLACE, MOVE_STANDARD, noble queen move, king adj, resurrect, morph, etc.
    if (a.payload?.to) {
      const okTo = selectedToSquare && a.payload.to === selectedToSquare;
      const okPiece = !selectedPieceId || a.payload.pieceId === selectedPieceId;
      if (okTo && okPiece) return it;
    }

    // Bishop block check: two targets (we can’t fully select this without more UI)
    // For now: require the user to select the king piece first, then click kingTo square.
    if (a.type === "NOBLE_BISHOP_BLOCK_CHECK") {
      if (selectedPieceId === `${side}_K` && selectedToSquare === a.payload.kingTo) {
        return it;
      }
    }

    // Rook swap: user selects piece A first, then clicks square of piece B
    if (a.type === "NOBLE_ROOK_SWAP") {
      const aSq = state.pieces[a.payload.pieceA]?.square;
      const bSq = state.pieces[a.payload.pieceB]?.square;
      const selSq = state.pieces[selectedPieceId]?.square;
      if (!selSq || !selectedToSquare) continue;
      const matches =
        (selSq === aSq && selectedToSquare === bSq) ||
        (selSq === bSq && selectedToSquare === aSq);
      if (matches) return it;
    }

    // NN combo (double/split) — we keep it simple:
    // if selectedPieceId exists, it must match the moving piece (for DOUBLE) and to must match one of move squares.
    if (a.type === "COMBO_NN") {
      if (a.payload.mode === "DOUBLE") {
        if (!selectedPieceId || a.payload.double.pieceId !== selectedPieceId) continue;
        if (selectedToSquare && a.payload.double.moves.some((m) => m.to === selectedToSquare)) return it;
      } else {
        // SPLIT is inherently 2-piece; needs a richer UI. We'll allow matching if destination matches either.
        if (selectedToSquare && (a.payload.split.a.to === selectedToSquare || a.payload.split.b.to === selectedToSquare)) {
          return it;
        }
      }
    }
  }

  return null;
}

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
