
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

// End-game banner (AI mode)
const endBanner = document.getElementById("endBanner");
const endBannerImg = document.getElementById("endBannerImg");
const btnEndBannerNew = document.getElementById("btnEndBannerNew");
const btnEndBannerClose = document.getElementById("btnEndBannerClose");



/* ---------------- Move Animation Layer ---------------- */
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

const victoryAudio = new Audio("trumpet-blast.mp3");
const defeatAudio  = new Audio("defeat-audio.mp3");
const victoryBannerSrc = "imgs/vic-banner.png";
const defeatBannerSrc  = "imgs/def-banner.png";

let endBannerShown = false;
let busy = false; // prevents AI / tick re-entrancy during animations

function hideEndBanner(){
  if (!endBanner) return;
  endBanner.classList.add("hidden");
}
function showEndBanner(kind){
  if (!endBanner || endBannerShown) return;
  endBannerShown = true;

  const isVictory = kind === "VICTORY";
  if (endBannerImg) endBannerImg.src = isVictory ? victoryBannerSrc : defeatBannerSrc;
  if (endBannerImg) {
    endBannerImg.onload = () => {};
    endBannerImg.onerror = () => console.warn("End banner image failed to load:", endBannerImg.src);
  }
  endBanner.classList.remove("hidden");

  const a = isVictory ? victoryAudio : defeatAudio;
  try{
    a.currentTime = 0;
    a.play().catch(()=>{});
  }catch{}
}


// Overlay layer for move animations (UI only)
const moveLayer = document.createElement("div");
moveLayer.id = "moveLayer";
document.body.appendChild(moveLayer);

function getSquareEl(sq) {
  return elBoard.querySelector(`.square[data-sq="${sq}"]`);
}

function getSquareRect(sq) {
  const el = getSquareEl(sq);
  if (!el) return null;
  return el.getBoundingClientRect();
}

function getPieceImgInSquare(sq) {
  const el = getSquareEl(sq);
  if (!el) return null;
  return el.querySelector("img.pieceImg") || el.querySelector("img");
}

function createGhostImgForPiece(piece) {
  const img = document.createElement("img");
  img.src = pieceImageSrc(piece);
  img.className = "moveGhost";
  img.draggable = false;
  return img;
}

function animateEl(el, keyframes, options) {
  return new Promise((resolve) => {
    const anim = el.animate(keyframes, options);
    anim.addEventListener("finish", () => resolve(), { once: true });
  });
}

async function animatePieceTravel({ pieceId, fromSq, toSq, kind }) {
  // kind: "MOVE" | "PLACE" | "CAPTURE"
  const pieceAfter = state?.pieces?.[pieceId];
  const pieceBefore = lastBeforeState?.pieces?.[pieceId];

  const fromRect = fromSq ? getSquareRect(fromSq) : null;
  const toRect = toSq ? getSquareRect(toSq) : null;
  if (!toRect) return;

  const ghostPiece = pieceAfter || pieceBefore;
  if (!ghostPiece) return;

  const ghost = createGhostImgForPiece(ghostPiece);
  moveLayer.appendChild(ghost);

  // size based on destination square (matches CSS: 72%)
  const size = Math.min(toRect.width, toRect.height) * 0.72;

  // Starting position
  const startRect = fromRect || toRect;
  const startX = startRect.left + (startRect.width - size) / 2;
  const startY = startRect.top + (startRect.height - size) / 2;

  // Ending position
  const endX = toRect.left + (toRect.width - size) / 2;
  const endY = toRect.top + (toRect.height - size) / 2;

  ghost.style.width = `${size}px`;
  ghost.style.height = `${size}px`;
  ghost.style.left = `${startX}px`;
  ghost.style.top = `${startY}px`;

  // Hide real pieces during animation to prevent "double"
  const fromImg = fromSq ? getPieceImgInSquare(fromSq) : null;
  const toImg = toSq ? getPieceImgInSquare(toSq) : null;

  const prevFromOpacity = fromImg?.style.opacity;
  const prevToOpacity = toImg?.style.opacity;

  if (fromImg) fromImg.style.opacity = "0";
  if (kind === "CAPTURE" && toImg) toImg.style.opacity = "0";

  const duration = kind === "PLACE" ? 380 : 520;

  // Lift effect (slight scale-up mid-flight)
  if (kind === "PLACE") {
    await animateEl(
      ghost,
      [
        { transform: "scale(0.65)", opacity: 0, offset: 0 },
        { transform: "scale(1.05)", opacity: 1, offset: 0.6 },
        { transform: "scale(1)", opacity: 1, offset: 1 },
      ],
      { duration, easing: "cubic-bezier(.2,.9,.2,1)", fill: "forwards" }
    );
  } else {
    const dx = endX - startX;
    const dy = endY - startY;
    await animateEl(
      ghost,
      [
        { transform: "translate(0px, 0px) scale(1)", offset: 0 },
        { transform: `translate(${dx}px, ${dy}px) scale(1.08)`, offset: 0.55 },
        { transform: `translate(${dx}px, ${dy}px) scale(1)`, offset: 1 },
      ],
      { duration, easing: "cubic-bezier(.2,.85,.25,1)", fill: "forwards" }
    );
  }

  // Cleanup
  ghost.remove();
  if (fromImg) fromImg.style.opacity = prevFromOpacity ?? "";
  if (toImg) toImg.style.opacity = prevToOpacity ?? "";
}

let lastBeforeState = null;


/**
 * Build a list of animation operations from before/after state and intent payload.
 * Each op: { pieceId, fromSq, toSq, kind }
 */
function getAnimOps(before, after, intent) {
  const ops = [];
  const t = intent?.action?.type;
  const a = intent?.action?.payload || {};

  const add = (pieceId, toSq) => {
    if (!pieceId || !toSq) return;
    const fromSq = before?.pieces?.[pieceId]?.square || null;
    const toAfter = after?.pieces?.[pieceId]?.square || toSq;

    // Determine if this was a place (no from square) or a move
    const kind = fromSq ? "MOVE" : "PLACE";

    // Capture detection: if destination had an enemy piece before and is now gone/inactive
    const capturedBeforeId = before?.board?.[toSq] || null;
    const capturedAfterId = after?.board?.[toSq] || null;
    const capturedWasRemoved = capturedBeforeId && capturedBeforeId !== pieceId && capturedAfterId === pieceId;
    const finalKind = capturedWasRemoved ? "CAPTURE" : kind;

    ops.push({ pieceId, fromSq, toSq: toAfter, kind: finalKind });
  };

  if (t === "PLACE") {
    add(a.pieceId, a.to);
    return ops;
  }

  if (t === "NOBLE_ROOK_SWAP_BACKRANK") {
    const aId = a.pieceA;
    const bId = a.pieceB;
    const aTo = before?.pieces?.[bId]?.square;
    const bTo = before?.pieces?.[aId]?.square;
    if (aId && aTo) ops.push({ pieceId: aId, fromSq: before.pieces[aId]?.square, toSq: aTo, kind: "MOVE" });
    if (bId && bTo) ops.push({ pieceId: bId, fromSq: before.pieces[bId]?.square, toSq: bTo, kind: "MOVE" });
    return ops;
  }

  if (t === "COMBO_NN") {
    if (a.mode === "DOUBLE") {
      const pid = a.double?.pieceId;
      const m0 = a.double?.moves?.[0]?.to;
      const m1 = a.double?.moves?.[1]?.to;
      if (pid && m0) ops.push({ pieceId: pid, fromSq: before?.pieces?.[pid]?.square || null, toSq: m0, kind: "MOVE" , seq: 0});
      if (pid && m1) ops.push({ pieceId: pid, fromSq: m0 || null, toSq: m1, kind: "MOVE", seq: 1 });
      return ops;
    }
    if (a.mode === "SPLIT") {
      const sa = a.split?.a;
      const sb = a.split?.b;
      if (sa?.pieceId && sa?.to) ops.push({ pieceId: sa.pieceId, fromSq: before?.pieces?.[sa.pieceId]?.square || null, toSq: sa.to, kind: "MOVE" });
      if (sb?.pieceId && sb?.to) ops.push({ pieceId: sb.pieceId, fromSq: before?.pieces?.[sb.pieceId]?.square || null, toSq: sb.to, kind: "MOVE" });
      return ops;
    }
  }

  if (t === "NOBLE_BISHOP_BLOCK_CHECK") {
    // King move then standard move
    const kingId = before?.board?.[a.kingFrom] || null; // may not exist
    const kingPieceId = Object.keys(before?.pieces || {}).find(pid => before.pieces[pid]?.side === intent.side && before.pieces[pid]?.type === "K");
    if (kingPieceId && a.kingTo) ops.push({ pieceId: kingPieceId, fromSq: before.pieces[kingPieceId]?.square || null, toSq: a.kingTo, kind: "MOVE", seq: 0 });
    const mv = a.move;
    if (mv?.pieceId && mv?.to) ops.push({ pieceId: mv.pieceId, fromSq: before.pieces[mv.pieceId]?.square || null, toSq: mv.to, kind: "MOVE", seq: 1 });
    return ops;
  }

  if (t === "NOBLE_BISHOP_RESURRECT") {
    // resurrect is a "PLACE" feel
    if (a.resurrectPieceId && a.to) ops.push({ pieceId: a.resurrectPieceId, fromSq: null, toSq: a.to, kind: "PLACE" });
    return ops;
  }

  // Default: payload pieceId + to
  if (a.pieceId && a.to) {
    // detect capture kind via board before/after
    const fromSq = before?.pieces?.[a.pieceId]?.square || null;
    const toSq = a.to;
    const destBefore = before?.board?.[toSq] || null;
    const kind = destBefore && destBefore !== a.pieceId ? "CAPTURE" : (fromSq ? "MOVE" : "PLACE");
    ops.push({ pieceId: a.pieceId, fromSq, toSq, kind });
    return ops;
  }

  return ops;
}

async function animateIntentTransition(before, after, intent) {
  // Keep access to before pieces for ghost sources
  lastBeforeState = before;

  const ops = getAnimOps(before, after, intent);
  if (!ops.length) return;

  // If we have sequenced ops (double-move etc.), run in order
  const seqOps = ops.filter(o => typeof o.seq === "number").sort((a,b)=>a.seq-b.seq);
  const parallelOps = ops.filter(o => typeof o.seq !== "number");

  // Run parallel moves first (swap/split), then sequenced (double) if any
  if (parallelOps.length) {
    await Promise.all(parallelOps.map(op => animatePieceTravel(op)));
  }
  for (const op of seqOps) {
    await animatePieceTravel(op);
  }
}

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
  const handEl = document.getElementById('hand');
  if (!handEl) return;

  // Determine which side's hand is relevant right now
  const st = state;
  const side = (st?.phase?.stage === 'SETUP')
    ? (st.phase?.setup?.sideToPlace || 'W')
    : (st?.phase?.turn?.side || 'W');
  const color = side === 'B' ? 'black' : 'white';

  handEl.innerHTML = '';
  handEl.classList.add('handGrid');

  const hand = st?.hands?.[side] || [];
  hand.forEach((cid) => {
    const kind = (cardKind(cid) || '').toLowerCase();
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'handCard' + (selectedCards.includes(cid) ? ' selected' : '');
    card.setAttribute('data-cid', cid);

    // Icon
    const img = document.createElement('img');
    img.className = 'handCardIcon';
    img.alt = kind ? kind.toUpperCase() : 'CARD';
    img.src = `imgs/${kind}-${color}.png`;
    card.appendChild(img);

    // Label
    const label = document.createElement('div');
    label.className = 'handCardLabel';
    label.textContent = (kind || 'CARD').toUpperCase();
    card.appendChild(label);

    card.addEventListener('click', () => {
      // Toggle selection; cap at 2 cards
      if (selectedCards.includes(cid)) {
        selectedCards = selectedCards.filter(x => x !== cid);
      } else {
        if (selectedCards.length >= 2) selectedCards = selectedCards.slice(1);
        selectedCards = [...selectedCards, cid];
      }
      render();
    });

    handEl.appendChild(card);
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

// End banner interactions
if (endBanner) {
  endBanner.addEventListener("click", (e) => {
    // clicking backdrop closes; clicking card/buttons shouldn't unless explicit
    if (e.target === endBanner.querySelector('.endBannerBackdrop')) hideEndBanner();
  });
}
if (btnEndBannerClose) btnEndBannerClose.onclick = () => hideEndBanner();
if (btnEndBannerNew) btnEndBannerNew.onclick = () => { hideEndBanner(); startNewGame(); };


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

async function onSquareClick(sq) {
  // SETUP flow (king is 1 click, knights are 2 clicks)
  if (state.phase.stage === "SETUP") {
    const side = state.phase.setup.sideToPlace;
    const intents = getLegalIntents(state, side);

    if (state.phase.setup.step === "PLACE_KING") {
      const pick = intents.find((it) => it.action?.payload?.to === sq);
      if (!pick) return;
      await stepApply(pick);
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

      await stepApply(pick);
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

btnConfirm.onclick = async () => {
  if (!pendingIntent) return;
  await stepApply(pendingIntent);

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

async function stepApply(intent) {
  if (busy) return;
  busy = true;
  try {

  const before = state;
  const after = applyIntent(before, intent);
  state = after;

  // Plain-English log (includes AI plays + card details)
  pushLog(describeIntent(intent));

  const res = evaluateGame(state);
  state.result = res; // ✅ keep state.result current so AI can run
  
  if (res?.status === "ENDED") pushLog(`GAME OVER: ${sideName(res.winner)} (${res.reason || "capture"})`);

  // AI mode end-game banner + audio (only when playing vs AI)
  if (chkAI.checked && res?.status === "ENDED") {
    const kind = (res.winner === "W") ? "VICTORY" : "DEFEAT";
    showEndBanner(kind);
  }

  setHint("—");
  await animateIntentTransition(before, after, intent);
  render();

  } finally {
    busy = false;
  }
}

async function tick() {
  if (!state) return;
  if (busy) return;

  // Hard stop: never allow any further actions once the game is ended
  if (state?.result?.status === "ENDED" || state?.phase?.stage === "ENDED") {
    return;
  }

  // AI handles its own SETUP (Black king placement) when enabled
  if (chkAI.checked && state.phase.stage === "SETUP" && state.phase.setup.sideToPlace === "B") {
    try {
      const intents = getLegalIntents(state, "B");
      const pick = intents[Math.floor(Math.random() * intents.length)];
      if (pick) {
        clearUiSelectionState();
        await stepApply(pick);
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
        await runAI();
      } catch (e) {
        console.error("AI error:", e);
        pushLog(`AI error: ${String(e?.message || e)}`);
      }
    }
}

async function runAI() {
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
        await sleep(450);
        await stepApply(it);
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

  // Small human-like thinking pause
  await sleep(450);
  await stepApply(best);
}

let loopHandle = null;

function startNewGame() {
  state = newGameState({ vsAI: chkAI.checked, aiSide: "B" });
  endBannerShown = false;
  hideEndBanner();
  try{ victoryAudio.pause(); victoryAudio.currentTime = 0; }catch{}
  try{ defeatAudio.pause(); defeatAudio.currentTime = 0; }catch{}
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
  loopHandle = setInterval(() => { tick(); }, 180);
}

startNewGame();
