
function pieceImageSrc(piece) {
  const typeMap = { K:"king", Q:"queen", R:"rook", B:"bishop", N:"knight", P:"pawn" };
  const color = piece.side === "W" ? "white" : "black";
  return `imgs/${typeMap[piece.type]}-${color}.png`;
}


import { newGameState } from "./engine/state.js";
import { getLegalIntents, applyIntent, evaluateGame, serverAdvanceDrawPhase } from "./engine/rules.js";
import { ACTION_LABEL } from "./engine/rulesSpec.js";

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

function isAITurn() {
  return (
    chkAI.checked &&
    state?.phase?.stage === "TURN" &&
    state.phase.turn.step === "PLAY" &&
    state.phase.turn.side === "B"
  );
}

function clearUiSelectionState() {
  selectedCards = [];
  lockedPlay = null;
  lockedActionType = null;
  pendingIntent = null;
  builder = null;
  setupBuilder = null;
  closeActionModal();
}

/* ---------------- Helpers ---------------- */

function setHint(msg) { elHint.textContent = msg || "—"; }

function pushLog(line) {
  logLines.push(line);
  if (logLines.length > 200) logLines.shift();
  elLog.textContent = logLines.join("\n");
}

function sideName(side) {
  if (chkAI.checked && side === "B") return "AI (Black)";
  return side === "W" ? "White" : "Black";
}

function pieceName(pieceId) {
  const p = state?.pieces?.[pieceId];
  if (!p) return pieceId;
  const typeMap = { K: "King", Q: "Queen", R: "Rook", B: "Bishop", N: "Knight", P: "Pawn" };
  return `${p.side === "W" ? "White" : "Black"} ${typeMap[p.type] || p.type}`;
}

function squareOrDash(sq) {
  return sq || "-";
}

function describeIntent(intent) {
  const who = sideName(intent.side);

  // Setup intent (no cards)
  if (intent.kind === "SETUP") {
    const to = intent.action?.payload?.to;
    return `${who} sets up: places King at ${squareOrDash(to)} (Knights auto-place adjacent).`;
  }

  const cards = playLabel(intent);
  const t = intent.action?.type;
  const a = intent.action?.payload || {};

  // Base action label
  let actionText = humanAction(t);

  // Add plain-English details
  if (t === "PLACE") {
    actionText = `${actionText}: ${pieceName(a.pieceId)} to ${squareOrDash(a.to)}`;
  } else if (t === "MOVE_STANDARD" || t?.startsWith("NOBLE_") || t?.startsWith("COMBO_")) {
    if (a.pieceId && a.to) {
      actionText = `${actionText}: ${pieceName(a.pieceId)} to ${squareOrDash(a.to)}`;
    } else if (t === "NOBLE_ROOK_SWAP_BACKRANK") {
      const A = state?.pieces?.[a.pieceA];
      const B = state?.pieces?.[a.pieceB];
      actionText = `${actionText}: swap ${pieceName(a.pieceA)} (${squareOrDash(A?.square)}) with ${pieceName(a.pieceB)} (${squareOrDash(B?.square)})`;
    } else if (t === "NOBLE_BISHOP_RESURRECT") {
      actionText = `${actionText}: resurrect ${pieceName(a.resurrectPieceId)} to ${squareOrDash(a.to)}`;
    } else if (t === "NOBLE_BISHOP_BLOCK_CHECK") {
      actionText = `${actionText}: King to ${squareOrDash(a.kingTo)}, then ${pieceName(a.move?.pieceId)} to ${squareOrDash(a.move?.to)}`;
    } else if (t === "COMBO_NN") {
      if (a.mode === "DOUBLE") {
        actionText = `${actionText}: ${pieceName(a.double?.pieceId)} to ${squareOrDash(a.double?.moves?.[0]?.to)}, then to ${squareOrDash(a.double?.moves?.[1]?.to)}`;
      } else if (a.mode === "SPLIT") {
        actionText = `${actionText}: ${pieceName(a.split?.a?.pieceId)} to ${squareOrDash(a.split?.a?.to)} AND ${pieceName(a.split?.b?.pieceId)} to ${squareOrDash(a.split?.b?.to)}`;
      }
    } else if (t === "COMBO_NX_MORPH") {
      const mode = a.mode === "KNIGHT_AS_X" ? `Knight moves like ${a.otherKind}` : `${a.otherKind} moves like Knight`;
      actionText = `${actionText} (${mode}): ${pieceName(a.pieceId)} to ${squareOrDash(a.to)}`;
    }
  }

  return `${who} played ${cards} → ${actionText}.`;
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

function cardLabel(cid) {
  return cardKind(cid) || cid;
}

function playLabel(intent) {
  const ids = intent.play?.cardIds || [];
  const kinds = ids.map(cardLabel);

  if (!ids.length) return "-";

  if (intent.play?.type === "SINGLE") {
    return `${kinds[0]} (${ids[0]})`;
  }

  // COMBO
  const sortedKinds = [...kinds].sort();
  const sortedIds = [...ids].sort();
  return `${sortedKinds.join("+")} (${sortedIds.join(",")})`;
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
    
cell.innerHTML = "";
if (pid) {
  const piece = state.pieces[pid];
  const img = document.createElement("img");
  img.src = pieceImageSrc(piece);
  img.className = "pieceImg";
  img.draggable = false;
  cell.appendChild(img);
}

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
    COMBO_NN: "Knight+Knight combo",
    COMBO_NX_MORPH: "Knight+X combo",
    COMBO_KING_KNIGHT: "King+Knight combo (King moves like a Knight)",
    NOBLE_KING_BACKRANK_KINGMOVE_NOCAP: "King Noble (back-rank piece moves like King, no capture)",
    NOBLE_ROOK_SWAP_BACKRANK: "Rook Noble (swap two back-rank pieces)",
    NOBLE_QUEEN_ANY_MOVE_EXTRA_TURN: "Queen Noble (any piece standard move + extra turn)",
    NOBLE_BISHOP_RESURRECT: "Bishop Noble (resurrect captured back-rank piece)",
    NOBLE_BISHOP_BLOCK_CHECK: "Bishop Noble (block check: king move + standard move)",
  };
  return map[type] || ACTION_LABEL?.[type] || type;
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

// ROOK swap: pick two back-rank pieces
if (lockedActionType === "NOBLE_ROOK_SWAP_BACKRANK") {
  handleSwapClick(sq, intents);
  return;
}

// BISHOP block check: king move then any standard move
if (lockedActionType === "NOBLE_BISHOP_BLOCK_CHECK") {
  handleBishopBlockCheckClick(sq, intents);
  return;
}

// BISHOP resurrect: click destination square on your back rank; if multiple pieces eligible, you'll be prompted
if (lockedActionType === "NOBLE_BISHOP_RESURRECT") {
  handleBishopResurrectClick(sq, intents);
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



function handleSwapClick(sq, intents) {
  // First click selects piece A, second selects piece B.
  if (!builder) {
    const p = pieceAt(sq);
    if (!p || p.side !== state.phase.turn.side) return;
    builder = { mode: "SWAP", firstPieceId: state.board[sq] };
    setHint("Swap: now click the second piece.");
    render();
    return;
  }
  if (builder.mode !== "SWAP") return;

  const secondId = state.board[sq];
  if (!secondId || secondId === builder.firstPieceId) return;

  const pick = intents.find((it) => {
    const pl = it.action?.payload;
    if (!pl) return false;
    const a = pl.pieceA, b = pl.pieceB;
    return (a === builder.firstPieceId && b === secondId) || (a === secondId && b === builder.firstPieceId);
  });

  if (!pick) {
    setHint("Not a legal swap.");
    pendingIntent = null;
    builder = null;
    updateButtons();
    render();
    return;
  }

  pendingIntent = pick;
  setHint("Legal swap selected. Click Confirm.");
  updateButtons();
  render();
}

function handleBishopBlockCheckClick(sq, intents) {
  // 1) Pick king destination, 2) pick a piece, 3) pick its destination.
  if (!builder) {
    const p = pieceAt(sq);
    if (!p || p.side !== state.phase.turn.side || p.type !== "K") return;
    builder = { mode: "BISHOP_BLOCK", kingFromSq: sq, kingToSq: null, moveFromSq: null, moveToSq: null };
    setHint("Block Check: click where the King will move.");
    render();
    return;
  }

  if (builder.mode !== "BISHOP_BLOCK") return;

  // pick kingTo
  if (!builder.kingToSq) {
    builder.kingToSq = sq;
    setHint("Now click a piece to move (standard move).");
    render();
    return;
  }

  // pick piece to move
  if (!builder.moveFromSq) {
    const p = pieceAt(sq);
    if (!p || p.side !== state.phase.turn.side) return;
    builder.moveFromSq = sq;
    setHint("Now click destination for that piece.");
    render();
    return;
  }

  // pick move destination and match intent
  if (!builder.moveToSq) {
    builder.moveToSq = sq;
    const pieceId = state.board[builder.moveFromSq];

    const pick = intents.find((it) => {
      const pl = it.action?.payload;
      if (!pl) return false;
      return pl.kingTo === builder.kingToSq && pl.move?.pieceId === pieceId && pl.move?.to === sq;
    });

    if (!pick) {
      setHint("Not legal for Bishop Block Check.");
      pendingIntent = null;
      builder.moveToSq = null;
      updateButtons();
      render();
      return;
    }

    pendingIntent = pick;
    setHint("Legal Block Check selected. Click Confirm.");
    updateButtons();
    render();
  }
}

function handleBishopResurrectClick(sq, intents) {
  const side = state.phase.turn.side;
  const backRank = side === "W" ? "1" : "8";
  if (sq[1] !== backRank) {
    setHint("Resurrect must be placed on your back rank.");
    return;
  }

  const options = intents.filter((it) => it.action?.payload?.to === sq);
  if (!options.length) {
    setHint("Not a legal resurrect square.");
    pendingIntent = null;
    updateButtons();
    return;
  }

  // If only one possible piece, take it; otherwise prompt user.
  let pick = options[0];
  if (options.length > 1) {
    const labels = options.map((it, i) => {
      const pid = it.action.payload.resurrectPieceId;
      const p = state.pieces[pid];
      return `${i + 1}: ${p.side}${p.type} (${pid})`;
    }).join("\n");
    const ans = window.prompt(`Choose piece to resurrect:\n${labels}`, "1");
    const idx = Math.max(1, Math.min(options.length, Number(ans || "1"))) - 1;
    pick = options[idx];
  }

  pendingIntent = pick;
  setHint("Legal Resurrect selected. Click Confirm.");
  updateButtons();
  render();
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

  // Plain-English log (includes AI plays + card details)
  pushLog(describeIntent(intent));

  const res = evaluateGame(state);
  state.result = res; // ✅ keep state.result current so AI can run
  
  if (res?.status === "ENDED") pushLog(`GAME OVER: ${sideName(res.winner)} (${res.reason || "capture"})`);

  setHint("—");
  render();
}

function tick() {
  if (!state) return;

  // AI handles its own SETUP (Black king placement) when enabled
  if (chkAI.checked && state.phase.stage === "SETUP" && state.phase.setup.sideToPlace === "B") {
    try {
      const intents = getLegalIntents(state, "B");
      const pick = intents[Math.floor(Math.random() * intents.length)];
      if (pick) {
        clearUiSelectionState();
        stepApply(pick);
      }
    } catch (e) {
      console.error("AI setup error:", e);
      pushLog(`AI setup error: ${String(e?.message || e)}`);
    }
    return;
  }

  if (state.phase.stage === "TURN" && state.phase.turn.step === "DRAW") {
    state = serverAdvanceDrawPhase(state);
    render();
    return;
  }

    if (isAITurn() && state.result?.status === "ONGOING") {
      // If the user started selecting cards for Black, wipe it
      clearUiSelectionState();
      render();
  
      try {
        runAI();
      } catch (e) {
        console.error("AI error:", e);
        pushLog(`AI error: ${String(e?.message || e)}`);
      }
    }
}

function runAI() {
  const side = "B";
  const intents = getLegalIntents(state, side);

  if (!intents.length) {
    // No legal moves; you can decide if that's stalemate/loss later.
    pushLog("AI has no legal moves.");
    return;
  }

  // 1) Try to find an immediate win (king capture)
  for (const it of intents) {
    try {
      const next = applyIntent(state, it);
      if (next?.phase?.stage === "ENDED" || next?.result?.status === "ENDED") {
        stepApply(it);
        return;
      }
    } catch {
      // skip illegal simulation
    }
  }

  // 2) Otherwise score candidates; never let one bad intent abort the AI turn
  function captureScore(it) {
    try {
      const before = state;
      const after = applyIntent(state, it);

      const beforePieces = Object.values(before.pieces).filter(p => p.status === "ACTIVE").length;
      const afterPieces  = Object.values(after.pieces).filter(p => p.status === "ACTIVE").length;
      const captured = beforePieces - afterPieces;

      const checkBonus = after.threat?.inCheck?.W ? 0.25 : 0;

      return captured + checkBonus;
    } catch {
      return -9999; // treat as unusable
    }
  }

  let best = null;
  let bestScore = -9999;

  for (const it of intents) {
    const sc = captureScore(it);
    if (sc > bestScore) {
      bestScore = sc;
      best = it;
    }
  }

  // Fallback: pick the first intent that applies cleanly
  if (!best || bestScore <= -9000) {
    for (const it of intents) {
      try {
        applyIntent(state, it);
        best = it;
        break;
      } catch {}
    }
  }

  if (!best) {
    pushLog("AI failed to choose a move.");
    return;
  }

  stepApply(best);
}

let loopHandle = null;

function startNewGame() {
  state = newGameState({ vsAI: chkAI.checked, aiSide: "B" });
  state.result = evaluateGame(state);
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
