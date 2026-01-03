import { newGameState } from "./engine/state.js";
import { getLegalIntents, applyIntent, evaluateGame, serverAdvanceDrawPhase } from "./engine/rules.js";

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
const btnPlaySingle = document.getElementById("btnPlaySingle");
const btnPlayCombo = document.getElementById("btnPlayCombo");
const btnClear = document.getElementById("btnClear");
const btnConfirm = document.getElementById("btnConfirm");
const btnEndTurn = document.getElementById("btnEndTurn");
const chkAI = document.getElementById("chkAI");

// Modal
const actionModal = document.getElementById("actionModal");
const actionModalOptions = document.getElementById("actionModalOptions");
const btnActionCancel = document.getElementById("btnActionCancel");

/* ---------------- State ---------------- */

let state = null;
let logLines = [];

let selectedCards = [];
let lockedPlay = null;       // { type:"SINGLE"|"COMBO", cardIds:[...], side }
let lockedActionType = null; // action.type chosen in modal
let pendingIntent = null;    // ready to confirm

// builders
let builder = null;          // TURN move builder
let setupBuilder = null;     // SETUP knights builder: { firstSq }

/* ---------------- Helpers ---------------- */

function setHint(msg) { elHint.textContent = msg || "—"; }

function pushLog(line) {
  logLines.push(line);
  if (logLines.length > 200) logLines.shift();
  elLog.textContent = logLines.join("\n");
}

function sameCards(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  const aa = [...a].sort();
  const bb = [...b].sort();
  for (let i = 0; i < aa.length; i++) if (aa[i] !== bb[i]) return false;
  return true;
}

function cardKind(cardId) {
  return state?.cardMeta?.[cardId]?.kind || state?.cardInstances?.[cardId]?.kind || null;
}

function pieceAt(sq) {
  const id = state.board[sq];
  return id ? state.pieces[id] : null;
}

/* ---------------- Render ---------------- */

function renderBoard() {
  if (!elBoard.dataset.ready) {
    elBoard.innerHTML = "";
    const files = ["a","b","c","d","e","f","g","h"];
    for (let r = 8; r >= 1; r--) {
      for (let f = 0; f < 8; f++) {
        const sq = `${files[f]}${r}`;
        const cell = document.createElement("div");
        cell.className = "square " + (((f + r) % 2 === 0) ? "light" : "dark");
        cell.dataset.sq = sq;
        cell.addEventListener("click", () => onSquareClick(sq));
        elBoard.appendChild(cell);
      }
    }
    elBoard.dataset.ready = "1";
  }

  const cells = elBoard.querySelectorAll(".square");
  cells.forEach((cell) => {
    const sq = cell.dataset.sq;
    const pid = state.board[sq];
    cell.textContent = pid ? prettyPiece(pid) : "";
    cell.classList.toggle("selected", builder?.fromSq === sq);
  });
}

function prettyPiece(pieceId) {
  const p = state.pieces[pieceId];
  if (!p) return pieceId;
  const map = { K:"K", Q:"Q", R:"R", B:"B", N:"N", P:"P" };
  return `${p.side}${map[p.type]}`;
}

function renderHand() {
  elHand.innerHTML = "";
  if (state.phase.stage !== "TURN") return;

  const side = state.phase.turn.side;
  const hand = state.hands?.[side] || [];

  hand.forEach((cid) => {
    const chip = document.createElement("div");
    chip.className = "card";
    chip.textContent = cardKind(cid) || "CARD";
    chip.dataset.cid = cid;

    chip.classList.toggle("selected", selectedCards.includes(cid));

    chip.addEventListener("click", () => {
      if (lockedPlay) return;
      toggleCard(cid);
    });

    elHand.appendChild(chip);
  });
}

function toggleCard(cid) {
  if (selectedCards.includes(cid)) selectedCards = selectedCards.filter((x) => x !== cid);
  else {
    if (selectedCards.length >= 2) return;
    selectedCards = [...selectedCards, cid];
  }
  pendingIntent = null;
  builder = null;
  updateButtons();
  renderHand();
  renderDebug();
}

function renderMeta() {
  pillStage.textContent = `Stage: ${state.phase.stage}`;
  if (state.phase.stage === "SETUP") {
    pillTurn.textContent = `Turn: ${state.phase.setup.sideToPlace} / ${state.phase.setup.step}`;
  } else {
    pillTurn.textContent = `Turn: ${state.phase.turn.side} / ${state.phase.turn.step}`;
  }
  pillCheck.textContent = `Check: W=${!!state.threat?.inCheck?.W} B=${!!state.threat?.inCheck?.B}`;
}

function renderDebug() {
  elDebug.textContent = JSON.stringify({
    result: state.result,
    phase: state.phase,
    hand: { W: state.hands?.W?.length ?? 0, B: state.hands?.B?.length ?? 0 },
    selection: { selectedCards, lockedPlay, lockedActionType, builder, setupBuilder, hasPending: !!pendingIntent }
  }, null, 2);
}

function render() {
  renderMeta();
  renderBoard();
  renderHand();
  renderDebug();
  updateButtons();
}

/* ---------------- Modal ---------------- */

function openActionModal(actionTypes) {
  actionModalOptions.innerHTML = "";
  actionTypes.forEach((t) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "modalBtn";
    btn.textContent = humanAction(t);
    btn.addEventListener("click", () => {
      lockedActionType = t;
      closeActionModal();
      setHint(`Action locked: ${humanAction(t)}. Now click the board.`);
      pendingIntent = null;
      builder = null;
      updateButtons();
      render();
    });
    actionModalOptions.appendChild(btn);
  });

  actionModal.classList.remove("hidden");
}

function closeActionModal() { actionModal.classList.add("hidden"); }
btnActionCancel.onclick = () => closeActionModal();

function humanAction(type) {
  const map = {
    PLACE: "Place a piece",
    MOVE_STANDARD: "Standard move",
    NOBLE_KING_ADJ_NO_CAPTURE: "King Noble (adjacent no-capture)",
    NOBLE_ROOK_SWAP: "Rook Noble (swap two non-pawns)",
    NOBLE_QUEEN_MOVE_EXTRA_TURN: "Queen Noble (move + extra turn)",
    COMBO_NN: "Knight+Knight combo",
    COMBO_NX_MORPH: "Knight+X morph combo"
  };
  return map[type] || type;
}

/* ---------------- Intent finding ---------------- */

function legalIntentsForSelection() {
  const side = state.phase.turn.side;
  const intents = getLegalIntents(state, side);

  if (!lockedPlay) return [];
  return intents.filter((it) => {
    const cids = it.play?.cardIds || [];
    const ptype = it.play?.type;
    if (ptype !== lockedPlay.type) return false;
    return sameCards(cids, lockedPlay.cardIds);
  });
}

function availableActionTypesForSelection() {
  const intents = legalIntentsForSelection();
  const set = new Set(intents.map((it) => it.action?.type).filter(Boolean));
  return [...set];
}

/* ---------------- Click handling ---------------- */

function onSquareClick(sq) {
  // SETUP flow (king is 1 click, knights are 2 clicks)
  if (state.phase.stage === "SETUP") {
    const side = state.phase.setup.sideToPlace;
    const intents = getLegalIntents(state, side);

    if (state.phase.setup.step === "PLACE_KING") {
      const pick = intents.find((it) => it.action?.payload?.to === sq);
      if (!pick) return;
      stepApply(pick);
      return;
    }

    if (state.phase.setup.step === "PLACE_KNIGHTS") {
      if (!setupBuilder) {
        setupBuilder = { firstSq: sq };
        setHint("Now click the second knight square.");
        render();
        return;
      }

      const a = setupBuilder.firstSq;
      const b = sq;
      setupBuilder = null;

      const pick = intents.find((it) => {
        const p = it.action?.payload;
        if (!p) return false;
        return (p.toA === a && p.toB === b) || (p.toA === b && p.toB === a);
      });

      if (!pick) {
        setHint("Not a legal knight pair. Try again.");
        return;
      }

      stepApply(pick);
      return;
    }

    return;
  }

  // TURN stage gating
  if (state.phase.turn.step !== "PLAY") return;

  if (!lockedPlay || !lockedActionType) {
    setHint("Select cards, click Play Single/Combo, then choose an action.");
    return;
  }

  const intents = legalIntentsForSelection().filter((it) => it.action?.type === lockedActionType);

  // PLACE: destination-only
  if (lockedActionType === "PLACE") {
    const pick = intents.find((it) => it.action?.payload?.to === sq);
    if (!pick) {
      setHint("Not a legal placement square for these cards.");
      pendingIntent = null;
      updateButtons();
      return;
    }
    pendingIntent = pick;
    setHint("Legal placement selected. Click Confirm.");
    updateButtons();
    return;
  }

  // COMBO_NN has its own click logic
  if (lockedActionType === "COMBO_NN") {
    handleComboNNClick(sq, intents);
    return;
  }

  // Default move-like: from then to
  if (!builder) {
    const p = pieceAt(sq);
    if (!p || p.side !== state.phase.turn.side) return;
    builder = { mode: "MOVE", fromSq: sq, toSq: null };
    setHint("Select a destination square.");
    render();
    return;
  }

  if (builder.mode === "MOVE" && !builder.toSq) {
    builder.toSq = sq;
    const fromId = state.board[builder.fromSq];

    const pick = intents.find((it) => it.action?.payload?.pieceId === fromId && it.action?.payload?.to === sq);

    if (!pick) {
      setHint("Not legal for these cards.");
      pendingIntent = null;
      builder.toSq = null;
      updateButtons();
      render();
      return;
    }

    pendingIntent = pick;
    setHint("Legal move selected. Click Confirm.");
    updateButtons();
    render();
    return;
  }
}

function handleComboNNClick(sq, intents) {
  // Choose a knight first
  if (!builder) {
    const p = pieceAt(sq);
    if (!p || p.side !== state.phase.turn.side || p.type !== "N") return;
    builder = { mode: "NN_PICK", fromSq: sq, toSq: null, first: null };
    setHint("Select destination (this will decide split vs double).");
    render();
    return;
  }

  // Choose destination for the first click
  if (builder.mode === "NN_PICK" && !builder.toSq) {
    builder.toSq = sq;
    const pieceId = state.board[builder.fromSq];

    // SPLIT detection: any SPLIT intent where this knight goes to sq
    const oneMoveDests = intents
      .filter((it) => it.action?.payload?.mode === "SPLIT")
      .flatMap((it) => [it.action.payload.split.a, it.action.payload.split.b])
      .filter((x) => x.pieceId === pieceId)
      .map((x) => x.to);

    const isOneMove = oneMoveDests.includes(sq);

    if (isOneMove) {
      builder.mode = "NN_SPLIT";
      builder.first = { pieceId, to: sq };
      builder.fromSq = null;
      builder.toSq = null;
      pendingIntent = null;
      setHint("Split: now select a SECOND knight, then its destination.");
      updateButtons();
      render();
      return;
    }

    // DOUBLE: find any DOUBLE intent where second move ends on sq
    const doubles = intents.filter(
      (it) => it.action?.payload?.mode === "DOUBLE" && it.action?.payload?.double?.pieceId === pieceId
    );
    const pick = doubles.find((it) => it.action.payload.double.moves?.[1]?.to === sq);

    if (!pick) {
      setHint("Not legal for NN combo.");
      pendingIntent = null;
      builder = null;
      updateButtons();
      render();
      return;
    }

    pendingIntent = pick;
    setHint("Double-move selected. Click Confirm.");
    updateButtons();
    render();
    return;
  }

  // SPLIT path: need second knight then destination
  if (builder.mode === "NN_SPLIT" && !builder.fromSq) {
    const p = pieceAt(sq);
    if (!p || p.side !== state.phase.turn.side || p.type !== "N") return;
    builder.fromSq = sq;
    setHint("Select destination for second knight.");
    render();
    return;
  }

  if (builder.mode === "NN_SPLIT" && builder.fromSq && !builder.toSq) {
    builder.toSq = sq;
    const secondId = state.board[builder.fromSq];

    const pick = intents.find((it) => {
      const pl = it.action?.payload;
      if (!pl || pl.mode !== "SPLIT") return false;
      const a = pl.split.a, b = pl.split.b;

      const m1 = builder.first;
      const m2 = { pieceId: secondId, to: sq };

      const sameOrder =
        a.pieceId === m1.pieceId && a.to === m1.to &&
        b.pieceId === m2.pieceId && b.to === m2.to;

      const swapped =
        b.pieceId === m1.pieceId && b.to === m1.to &&
        a.pieceId === m2.pieceId && a.to === m2.to;

      return sameOrder || swapped;
    });

    if (!pick) {
      setHint("Not legal split selection.");
      pendingIntent = null;
      builder.toSq = null;
      updateButtons();
      render();
      return;
    }

    pendingIntent = pick;
    setHint("Split selected. Click Confirm.");
    updateButtons();
    render();
  }
}

/* ---------------- Buttons ---------------- */

function updateButtons() {
  const stage = state.phase.stage;
  const turnStep = stage === "TURN" ? state.phase.turn.step : null;

  btnPlaySingle.disabled = !(stage === "TURN" && turnStep === "PLAY" && !lockedPlay && selectedCards.length === 1);
  btnPlayCombo.disabled  = !(stage === "TURN" && turnStep === "PLAY" && !lockedPlay && selectedCards.length === 2);

  btnClear.disabled = !(selectedCards.length || lockedPlay || lockedActionType || builder || setupBuilder || pendingIntent);

  btnConfirm.disabled = !pendingIntent;
  btnEndTurn.disabled = !(stage === "TURN" && turnStep === "PLAY");
}

btnPlaySingle.onclick = () => {
  const side = state.phase.turn.side;
  lockedPlay = { type: "SINGLE", cardIds: [...selectedCards], side };
  const types = availableActionTypesForSelection();
  if (!types.length) {
    setHint("Not legal for these cards.");
    lockedPlay = null;
    return;
  }
  openActionModal(types);
};

btnPlayCombo.onclick = () => {
  const side = state.phase.turn.side;
  lockedPlay = { type: "COMBO", cardIds: [...selectedCards], side };
  const types = availableActionTypesForSelection();
  if (!types.length) {
    setHint("Not legal for these cards.");
    lockedPlay = null;
    return;
  }
  openActionModal(types);
};

btnClear.onclick = () => {
  selectedCards = [];
  lockedPlay = null;
  lockedActionType = null;
  builder = null;
  setupBuilder = null;
  pendingIntent = null;
  setHint("—");
  closeActionModal();
  render();
};

btnConfirm.onclick = () => {
  if (!pendingIntent) return;
  stepApply(pendingIntent);

  selectedCards = [];
  lockedPlay = null;
  lockedActionType = null;
  builder = null;
  pendingIntent = null;

  render();
};

btnEndTurn.onclick = () => {
  setHint("End Turn is automatic after you Confirm an action.");
};

btnNewGame.onclick = () => startNewGame();
btnReset.onclick = () => startNewGame();

/* ---------------- Apply + AI + Loop ---------------- */

function stepApply(intent) {
  const before = state;
  const after = applyIntent(before, intent);
  state = after;

  const side = intent.side || before.phase.turn?.side || "?";
  const cid = intent.play?.cardIds?.join(",") || "-";
  pushLog(`${side} played ${cid} -> ${intent.action?.type || "?"}`);

  const res = evaluateGame(state);
  state.result = res; // ✅ keep state.result current so AI can run
  
  if (res?.status === "ENDED") {
    pushLog(`GAME OVER: ${res.winner} (${res.reason || "capture"})`);
  }

  setHint("—");
  render();
}

function tick() {
  if (!state) return;

  if (state.phase.stage === "TURN" && state.phase.turn.step === "DRAW") {
    state = serverAdvanceDrawPhase(state);
    render();
    return;
  }

  if (
    chkAI.checked &&
    state.phase.stage === "TURN" &&
    state.phase.turn.step === "PLAY" &&
    state.phase.turn.side === "B" &&
    state.result?.status === "ONGOING"
  ) {
    runAI();
  }
}

function runAI() {
  const side = "B";
  const intents = getLegalIntents(state, side);
  if (!intents.length) return;

  for (const it of intents) {
    const next = applyIntent(state, it);
    if (next?.result?.status === "ENDED" && next.result.winner === side) {
      stepApply(it);
      return;
    }
  }

  function captureScore(it) {
    const before = state;
    const after = applyIntent(state, it);
    const beforePieces = Object.values(before.pieces).filter(p => p.status === "ACTIVE").length;
    const afterPieces  = Object.values(after.pieces).filter(p => p.status === "ACTIVE").length;
    const captured = beforePieces - afterPieces;
    const checkBonus = after.threat?.inCheck?.W ? 0.25 : 0;
    return captured + checkBonus;
  }

  let best = null, bestScore = -999;
  for (const it of intents) {
    const sc = captureScore(it);
    if (sc > bestScore) { bestScore = sc; best = it; }
  }

  if (!best) best = intents[Math.floor(Math.random() * intents.length)];
  stepApply(best);
}

let loopHandle = null;

function startNewGame() {
  state = newGameState({ vsAI: chkAI.checked, aiSide: "B" });
  logLines = [];
  selectedCards = [];
  lockedPlay = null;
  lockedActionType = null;
  builder = null;
  setupBuilder = null;
  pendingIntent = null;

  setHint("Starting game… (click squares to place King, then pick 2 squares for Knights)");
  closeActionModal();
  render();

  if (loopHandle) clearInterval(loopHandle);
  loopHandle = setInterval(tick, 180);
}

startNewGame();
