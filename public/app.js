import { newGameState } from "./engine/state.js";
import { getLegalIntents, applyIntent, evaluateGame } from "./engine/rules.js";

/* ---------------- DOM ---------------- */

const elBoard = document.getElementById("board");
const elHand = document.getElementById("hand");
const elLog = document.getElementById("log");
const elDebug = document.getElementById("debug");
const elHint = document.getElementById("hint");
const pillStage = document.getElementById("pillStage");
const pillTurn = document.getElementById("pillTurn");
const pillCheck = document.getElementById("pillCheck");

const btnNewGame = document.getElementById("btnNewGame");
const btnReset = document.getElementById("btnReset");
const chkAI = document.getElementById("chkAI");

const btnPlaySingle = document.getElementById("btnPlaySingle");
const btnPlayCombo = document.getElementById("btnPlayCombo");
const btnClear = document.getElementById("btnClear");
const btnConfirm = document.getElementById("btnConfirm");
const btnEndTurn = document.getElementById("btnEndTurn");

// Action chooser modal
const actionModal = document.getElementById("actionModal");
const actionModalTitle = document.getElementById("actionModalTitle");
const actionModalOptions = document.getElementById("actionModalOptions");
const btnActionCancel = document.getElementById("btnActionCancel");

/* ---------------- State ---------------- */

let state = newGameState();
let logLines = [];

let selectedCards = [];
let lockedPlay = null; // { type:"SINGLE"|"COMBO", cardIds:[...], side:"W"|"B" }
let lockedAction = null; // 'PLACE' | 'MOVE' | 'NOBLE' | 'COMBO'
let builder = null;
let pendingIntent = null;

/* ---------------- Helpers ---------------- */

function controllingSide() {
  return state.phase.turn.side;
}

function pushLog(s) {
  logLines.push(s);
  if (logLines.length > 60) logLines.shift();
}

function cardLabel(cardId) {
  // your card IDs are like c_0012 etc; engine should also have a card type in state.deck/cards
  const c = state.cards?.[cardId] || state.deck?.[cardId];
  if (!c) return cardId;
  return c.kind || c.type || c.name || cardId;
}

/* ---------------- Modal helpers ---------------- */

function getLockedCandidates(st = state, lp = lockedPlay) {
  if (!lp) return [];
  const legal = getLegalIntents(st, lp.side);
  const want = new Set(lp.cardIds);
  return legal.filter((it) => {
    const ids = it.play?.cardIds || [];
    if (ids.length !== want.size) return false;
    for (const id of ids) if (!want.has(id)) return false;
    return true;
  });
}

function filterCandidatesByAction(candidates, actionKind) {
  if (!actionKind) return candidates;
  if (actionKind === "PLACE") return candidates.filter((it) => it.action?.type === "PLACE");
  if (actionKind === "MOVE") return candidates.filter((it) => it.action?.type === "MOVE_STANDARD");
  if (actionKind === "NOBLE") return candidates.filter((it) => (it.action?.type || "").startsWith("NOBLE_"));
  if (actionKind === "COMBO") return candidates.filter((it) => (it.action?.type || "").startsWith("COMBO"));
  return candidates;
}

function availableActionKindsForLockedPlay() {
  const candidates = getLockedCandidates();
  const kinds = [];
  if (candidates.some((it) => it.action?.type === "PLACE")) kinds.push("PLACE");
  if (candidates.some((it) => it.action?.type === "MOVE_STANDARD")) kinds.push("MOVE");
  if (candidates.some((it) => (it.action?.type || "").startsWith("NOBLE_"))) kinds.push("NOBLE");
  if (candidates.some((it) => (it.action?.type || "").startsWith("COMBO"))) kinds.push("COMBO");
  return kinds;
}

function labelForActionKind(k) {
  if (k === "PLACE") return "Place";
  if (k === "MOVE") return "Standard Move";
  if (k === "NOBLE") return "Noble Action";
  if (k === "COMBO") return "Combo";
  return k;
}

function openActionModal() {
  const kinds = availableActionKindsForLockedPlay();

  // auto pick if only one possible
  if (kinds.length === 1) {
    lockedAction = kinds[0];
    builder = inferBuilderMode();
    pendingIntent = null;
    render();
    return;
  }

  actionModalOptions.innerHTML = "";
  for (const k of kinds) {
    const btn = document.createElement("button");
    btn.className = "modalBtn";
    btn.textContent = labelForActionKind(k);
    btn.onclick = () => {
      lockedAction = k;
      builder = inferBuilderMode();
      pendingIntent = null;
      closeActionModal();
      render();
    };
    actionModalOptions.appendChild(btn);
  }

  actionModalTitle.textContent = "Choose your action";
  actionModal.classList.remove("hidden");
}

function closeActionModal() {
  actionModal.classList.add("hidden");
}

/* ---------------- Builder inference + intent matching ---------------- */

function inferBuilderMode() {
  if (!lockedPlay) return null;

  const all = getLockedCandidates();
  const candidates = filterCandidatesByAction(all, lockedAction);

  if (!lockedAction) return null;

  if (lockedAction === "NOBLE") {
    if (candidates.some((it) => it.action?.type === "NOBLE_ROOK_SWAP")) {
      return { mode: "ROOK_SWAP", aId: null, bId: null };
    }
    return { mode: "GENERIC", pieceId: null, to: null };
  }

  if (lockedAction === "COMBO") {
    if (candidates.some((it) => it.action?.type === "COMBO_NN")) {
      return {
        mode: "NN_AUTO",
        phase: "PICK_KNIGHT1",
        k1: null, to1: null,
        k2: null, to2: null,
        doubleTo2: null,
        forcedFinal: null,
        possibleDoubleIntents: null,
      };
    }
    return { mode: "GENERIC", pieceId: null, to: null };
  }

  return { mode: "GENERIC", pieceId: null, to: null };
}

function findPendingFromBuilder() {
  const all = getLockedCandidates(state, lockedPlay);
  const candidates = filterCandidatesByAction(all, lockedAction);

  // NN AUTO match
  if (builder?.mode === "NN_AUTO") {
    const b = builder;

    // If we already forced a unique DOUBLE intent via shortcut, use it
    if (b.forcedFinal && pendingIntent && pendingIntent.action?.type === "COMBO_NN") {
      return pendingIntent;
    }

    const nn = candidates.filter((it) => it.action?.type === "COMBO_NN");

    // SPLIT: k1+to1 then k2+to2
    if (b.k1 && b.to1 && b.k2 && b.to2) {
      return nn.find((it) => {
        const a = it.action;
        if (a.payload.mode !== "SPLIT") return false;
        const A = a.payload.split.a;
        const B = a.payload.split.b;

        const direct =
          A.pieceId === b.k1 && A.to === b.to1 &&
          B.pieceId === b.k2 && B.to === b.to2;

        const swapped =
          A.pieceId === b.k2 && A.to === b.to2 &&
          B.pieceId === b.k1 && B.to === b.to1;

        return direct || swapped;
      }) || null;
    }

    // DOUBLE: k1+to1 then doubleTo2
    if (b.k1 && b.to1 && b.doubleTo2) {
      return nn.find((it) => {
        const a = it.action;
        if (a.payload.mode !== "DOUBLE") return false;
        if (a.payload.double.pieceId !== b.k1) return false;
        const m = a.payload.double.moves;
        if (!m || m.length !== 2) return false;
        if (m[0].to !== b.to1) return false;
        if (m[1].to !== b.doubleTo2) return false;
        return true;
      }) || null;
    }

    return null;
  }

  // ROOK swap builder
  if (builder?.mode === "ROOK_SWAP") {
    const b = builder;
    if (!b.aId || !b.bId) return null;
    return candidates.find((it) => {
      if (it.action?.type !== "NOBLE_ROOK_SWAP") return false;
      const p = it.action.payload;
      return (p.aId === b.aId && p.bId === b.bId) || (p.aId === b.bId && p.bId === b.aId);
    }) || null;
  }

  // GENERIC match (pieceId + to)
  if (builder?.mode === "GENERIC") {
    const b = builder;
    if (!b.pieceId && !b.to) return null;

    return candidates.find((it) => {
      const a = it.action;
      if (!a) return false;

      // PLACE usually has { pieceType, to }
      if (a.type === "PLACE") {
        if (!b.to) return false;
        return a.to === b.to;
      }

      // MOVE_STANDARD / nobles / combos use pieceId/to
      if (a.pieceId && b.pieceId && a.pieceId !== b.pieceId) return false;
      if (a.to && b.to && a.to !== b.to) return false;

      // If builder has pieceId but intent has no pieceId (edge case), reject.
      if (b.pieceId && !a.pieceId) return false;

      return true;
    }) || null;
  }

  return null;
}

/* ---------------- UI events ---------------- */

btnNewGame.onclick = () => startNewGame();
btnReset.onclick = () => startNewGame();

btnPlaySingle.onclick = () => {
  if (selectedCards.length !== 1) return;
  lockedPlay = { type: "SINGLE", cardIds: [...selectedCards], side: controllingSide() };
  lockedAction = null;
  builder = null;
  pendingIntent = null;
  render();
  openActionModal();
};

btnPlayCombo.onclick = () => {
  if (selectedCards.length !== 2) return;
  lockedPlay = { type: "COMBO", cardIds: [...selectedCards], side: controllingSide() };
  lockedAction = null;
  builder = null;
  pendingIntent = null;
  render();
  openActionModal();
};

btnClear.onclick = () => {
  selectedCards = [];
  lockedPlay = null;
  lockedAction = null;
  builder = null;
  pendingIntent = null;
  closeActionModal();
  render();
};

btnActionCancel.onclick = () => {
  lockedPlay = null;
  lockedAction = null;
  builder = null;
  pendingIntent = null;
  closeActionModal();
  render();
};

btnConfirm.onclick = () => {
  if (!pendingIntent) return;
  stepApply(pendingIntent);
};

btnEndTurn.onclick = () => {
  // your rules engine likely has an end-turn intent, but if not, you’re already doing it via a “pass” action in rules
  // keep your existing end-turn behavior here if you had it; this is a safe reset:
  selectedCards = [];
  lockedPlay = null;
  lockedAction = null;
  builder = null;
  pendingIntent = null;
  closeActionModal();
  render();
};

/* ---------------- Board interaction ---------------- */

function onSquareClick(square) {
  if (lockedPlay && !lockedAction) return;

  if (!lockedPlay) return;

  if (!builder) builder = inferBuilderMode();
  if (!builder) return;

  // NN builder handling must remain aligned with your existing NN flow.
  if (builder.mode === "NN_AUTO") {
    // Keep your existing NN selection logic if you already have it;
    // This file assumes you already implemented NN split/double selection logic.
    // If you want, next step we’ll explicitly implement the “intent hierarchy” you described.
    // For now, don’t break your current NN system:
  }

  // GENERIC + ROOK_SWAP:
  if (builder.mode === "GENERIC") {
    builder.to = square;
  } else if (builder.mode === "ROOK_SWAP") {
    // for swap you likely pick pieces by clicking piece; square click does nothing
  }

  pendingIntent = findPendingFromBuilder();
  render();
}

/* ---------------- Rendering ---------------- */

function render() {
  // pills
  pillStage.textContent = `Stage: ${state.phase.stage}`;
  pillTurn.textContent = `Turn: ${state.phase.turn.side} / ${state.phase.turn.step}`;
  pillCheck.textContent = `Check: W=${!!state.check?.W} B=${!!state.check?.B}`;

  // hint/buttons gating
  renderHintAndButtons();

  // debug/log
  elLog.textContent = logLines.join("\n");
  elDebug.textContent = JSON.stringify(state, null, 2);

  // render hand
  renderHand();

  // render board
  renderBoard();
}

function renderHintAndButtons() {
  btnConfirm.disabled = true;

  // drawing step lock
  if (state.phase.turn.step !== "PLAY") {
    elHint.textContent = "Drawing...";
    btnPlaySingle.disabled = true;
    btnPlayCombo.disabled = true;
    btnEndTurn.disabled = true;
    return;
  }

  // must pick an action kind before touching pieces/squares
  if (lockedPlay && !lockedAction) {
    elHint.textContent = "Choose action type (Place / Move / Noble / Combo).";
    btnPlaySingle.disabled = true;
    btnPlayCombo.disabled = true;
    btnEndTurn.disabled = true;
    return;
  }

  btnEndTurn.disabled = false;

  if (!lockedPlay) {
    elHint.textContent = "Select 1 card (single) or 2 cards (combo), then choose Play Single/Combo.";
    btnPlaySingle.disabled = selectedCards.length !== 1;
    btnPlayCombo.disabled = selectedCards.length !== 2;
    return;
  }

  // locked + chosen action
  const kinds = availableActionKindsForLockedPlay().map(labelForActionKind).join(", ");
  elHint.textContent = `Locked cards. Action type: ${labelForActionKind(lockedAction)}. (Legal: ${kinds})`;

  btnPlaySingle.disabled = true;
  btnPlayCombo.disabled = true;

  // confirm only when we have a real match
  pendingIntent = findPendingFromBuilder();
  btnConfirm.disabled = !pendingIntent;
  if (pendingIntent) elHint.textContent = "Legal selection. Click Confirm.";
}

function renderHand() {
  elHand.innerHTML = "";

  const side = controllingSide();
  const handIds = state.hands?.[side] || [];

  handIds.forEach((cardId) => {
    const btn = document.createElement("button");
    btn.className = "cardBtn";
    btn.textContent = (state.cardMeta?.[cardId]?.label) || cardLabel(cardId);

    const selected = selectedCards.includes(cardId);
    if (selected) btn.classList.add("selected");

    btn.onclick = () => {
      if (lockedPlay) return; // can’t change hand after locking
      if (selected) {
        selectedCards = selectedCards.filter((x) => x !== cardId);
      } else {
        if (selectedCards.length >= 2) return;
        selectedCards = [...selectedCards, cardId];
      }
      render();
    };

    elHand.appendChild(btn);
  });
}

function renderBoard() {
  // Your board renderer likely already exists; keep yours.
  // This placeholder assumes you already render squares and pieces and call onSquareClick.
  // If you want, paste your existing renderBoard and I’ll merge cleanly.

  // IMPORTANT: make sure the square click calls onSquareClick(squareId)
  // and you do NOT pre-highlight legal moves anymore (per your strategy preference).
}

/* ---------------- Apply intents + AI ---------------- */

function stepApply(intent) {
  const before = state;
  const after = applyIntent(before, intent);

  state = after;

  // log
  const side = intent.play?.side || intent.side || before.phase.turn.side;
  const cid = intent.play?.cardIds?.join(",") || "-";
  pushLog(`${side} played ${cid} -> ${intent.action?.type || "?"}`);

  // clear selection
  selectedCards = [];
  lockedPlay = null;
  lockedAction = null;
  builder = null;
  pendingIntent = null;
  closeActionModal();

  // evaluate
  const res = evaluateGame(state);
  if (res?.status && res.status !== "ONGOING") {
    pushLog(`Game ended: ${res.status} winner=${res.winner || "-"} reason=${res.reason || "-"}`);
  }

  // AI move if enabled
  if (chkAI.checked && state.phase.turn.side === "B" && res?.status === "ONGOING") {
    runAI();
  }

  render();
}

function runAI() {
  // You said AI is still easy; we’ll upgrade its evaluator next.
  // For now keep your existing AI logic if you already have it.
}

/* ---------------- Start game ---------------- */

function startNewGame() {
  state = newGameState();
  logLines = [];

  selectedCards = [];
  lockedPlay = null;
  lockedAction = null;
  builder = null;
  pendingIntent = null;

  closeActionModal();
  render();
}

startNewGame();
