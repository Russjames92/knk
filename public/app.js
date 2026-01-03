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

// UI selection state
let selectedCards = [];
let selectedSquare = null;
let pendingIntent = null;

// Offline control: local player always White; Black is either human (hotseat) or AI
function isAIEnabled(){ return !!aiToggle.checked; }

btnNew.onclick = () => startNewGame();
btnReset.onclick = () => startNewGame();

btnClear.onclick = () => {
  selectedCards = [];
  selectedSquare = null;
  pendingIntent = null;
  render();
};

btnPlaySingle.onclick = () => {
  if(selectedCards.length !== 1) return;
  buildPending();
};

btnPlayCombo.onclick = () => {
  if(selectedCards.length !== 2) return;
  buildPending();
};

btnConfirm.onclick = () => {
  if(!pendingIntent) return;
  stepApply(pendingIntent);
};

btnEndTurn.onclick = () => {
  selectedCards = [];
  selectedSquare = null;
  pendingIntent = null;
  render();
};

function startNewGame(){
  state = createNewGameState({ vsAI: isAIEnabled(), aiSide:"B" });
  elStatus.textContent = "Offline (GitHub Pages)";
  selectedCards = [];
  selectedSquare = null;
  pendingIntent = null;
  tick();
  render();
}

function tick(){
  state = serverAdvanceDrawPhase(state);

  // If AI turn, play automatically until it's human's turn or game ends.
  while(state.result.status === "ONGOING" && state.phase.stage === "TURN" && state.phase.turn.step === "PLAY"){
    const side = state.phase.turn.side;
    if(side === "B" && isAIEnabled()){
      const legal = getLegalIntents(state, "B");
      if(legal.length === 0) break;
      const choice = legal[Math.floor(Math.random()*legal.length)];
      state = applyIntentStrict(state, choice);
      state = serverAdvanceDrawPhase(state);
      continue;
    }
    break;
  }
}

function stepApply(intent){
  state = applyIntentStrict(state, intent);
  selectedCards = [];
  selectedSquare = null;
  pendingIntent = null;
  tick();
  render();
}

function render(){
  if(!state){
    elInfo.textContent = "Click New Game.";
    return;
  }

  elPhasePill.textContent = `Stage: ${state.phase.stage}`;
  if(state.phase.stage === "SETUP"){
    elTurnPill.textContent = `Setup: ${state.phase.setup.sideToPlace} / ${state.phase.setup.step}`;
  } else {
    elTurnPill.textContent = `Turn: ${state.phase.turn.side} / ${state.phase.turn.step}`;
  }
  elCheckPill.textContent = `Check: W=${!!state.threat?.inCheck?.W} B=${!!state.threat?.inCheck?.B}`;

  elInfo.textContent = JSON.stringify({
    result: state.result,
    phase: state.phase,
    hand: { W: state.cards.W.hand.length, B: state.cards.B.hand.length }
  }, null, 2);

  renderHand();
  renderBoard();
  renderLog();
  renderHintAndButtons();
}

function renderHintAndButtons(){
  const stage = state.phase.stage;

  btnPlaySingle.disabled = true;
  btnPlayCombo.disabled = true;
  btnClear.disabled = false;
  btnConfirm.disabled = !pendingIntent;
  btnEndTurn.disabled = false;

  if(state.result.status !== "ONGOING"){
    elHint.textContent = `Game Over — Winner: ${state.result.winner} (${state.result.reason})`;
    btnConfirm.disabled = true;
    return;
  }

  if(stage === "SETUP"){
    const side = state.phase.setup.sideToPlace;
    const step = state.phase.setup.step;
    elHint.textContent =
      step === "PLACE_KING"
        ? `${side}: Place your King on the back rank (not a corner). Click a square.`
        : `${side}: Place your Knights adjacent to your King (left/right). Click a square.`;
    return;
  }

  if(state.phase.turn.step !== "PLAY"){
    elHint.textContent = "Drawing...";
    return;
  }

  elHint.textContent = pendingIntent
    ? "Ready. Click Confirm to commit the action."
    : "Select 1 card (single) or 2 cards (combo), then click a highlighted square.";

  if(selectedCards.length === 1) btnPlaySingle.disabled = false;
  if(selectedCards.length === 2) btnPlayCombo.disabled = false;
}

function renderHand(){
  elHand.innerHTML = "";
  const side = currentControllingSide();
  const hand = state.cards?.[side]?.hand || [];

  for(const cid of hand){
    const c = state.cardInstances[cid];
    const div = document.createElement("div");
    div.className = "card" + (selectedCards.includes(cid) ? " selected" : "");
    div.textContent = c.kind;

    div.onclick = () => {
      if(selectedCards.includes(cid)){
        selectedCards = selectedCards.filter(x => x !== cid);
      } else {
        if(selectedCards.length >= 2) return;
        selectedCards = [...selectedCards, cid];
      }
      pendingIntent = null;
      selectedSquare = null;
      render();
    };

    elHand.appendChild(div);
  }
}

function currentControllingSide(){
  if(isAIEnabled()) return "W";
  if(state.phase.stage === "SETUP") return state.phase.setup.sideToPlace;
  return state.phase.turn.side;
}

function renderBoard(){
  elBoard.innerHTML = "";

  const legal = computeLegalForUI();
  const legalSquares = new Set();
  const enemyKingSquares = new Set();

  for(const it of legal){
    const a = it.action;

    // setup highlights
    if(a.type === "SETUP_PLACE_KING") legalSquares.add(a.payload.to);
    if(a.type === "SETUP_PLACE_KNIGHTS"){
      legalSquares.add(a.payload.left);
      legalSquares.add(a.payload.right);
    }

    // standard single-target moves / places
    if(a.payload?.to) legalSquares.add(a.payload.to);

    // bishop block check has 2 targets
    if(a.type === "NOBLE_BISHOP_BLOCK_CHECK"){
      legalSquares.add(a.payload.kingTo);
      legalSquares.add(a.payload.followup.to);
    }

    // NN combo highlights
    if(a.type === "COMBO_NN"){
      if(a.payload.mode === "DOUBLE"){
        for(const mv of a.payload.double.moves) legalSquares.add(mv.to);
      } else {
        legalSquares.add(a.payload.split.a.to);
        legalSquares.add(a.payload.split.b.to);
      }
    }

    // rook swap highlight by the two piece squares
    if(a.type === "NOBLE_ROOK_SWAP"){
      const sqA = state.pieces[a.payload.pieceA].square;
      const sqB = state.pieces[a.payload.pieceB].square;
      if(sqA) legalSquares.add(sqA);
      if(sqB) legalSquares.add(sqB);
    }

    // mark enemy king capture squares
    const to = a.payload?.to;
    if(to){
      const pid = state.board[to];
      if(pid && state.pieces[pid].type === "K" && state.pieces[pid].side !== it.side){
        enemyKingSquares.add(to);
      }
    }
  }

  const files = ["a","b","c","d","e","f","g","h"];
  for(let r=8;r>=1;r--){
    for(let f=0;f<8;f++){
      const square = `${files[f]}${r}`;
      const isDark = (f + r) % 2 === 0;

      const div = document.createElement("div");
      const classes = ["square", isDark ? "dark":"light"];
      if(legalSquares.has(square)) classes.push("legal");
      if(enemyKingSquares.has(square)) classes.push("enemyKing");
      if(selectedSquare === square) classes.push("selected");
      div.className = classes.join(" ");

      const pid = state.board?.[square];
      if(pid){
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

function onSquareClick(square){
  if(state.result.status !== "ONGOING") return;

  selectedSquare = square;

  if(state.phase.stage === "SETUP"){
    const side = state.phase.setup.sideToPlace;
    const step = state.phase.setup.step;

    if(step === "PLACE_KING"){
      pendingIntent = {
        kind:"SETUP",
        side,
        action:{ type:"SETUP_PLACE_KING", payload:{ to: square } }
      };
      render();
      return;
    }

    if(step === "PLACE_KNIGHTS"){
      const legal = computeLegalForUI();
      const match = legal.find(it => it.action.type==="SETUP_PLACE_KNIGHTS"
        && (it.action.payload.left===square || it.action.payload.right===square));
      pendingIntent = match || null;
      render();
      return;
    }
  }

  if(state.phase.stage === "TURN" && state.phase.turn.step === "PLAY"){
    buildPending();
    render();
  }
}

function buildPending(){
  pendingIntent = null;

  const side = currentControllingSide();
  if(state.phase.stage !== "TURN") return;
  if(state.phase.turn.side !== side) return;
  if(state.phase.turn.step !== "PLAY") return;

  if(selectedCards.length !== 1 && selectedCards.length !== 2) return;

  const legal = computeLegalForUI();
  const want = new Set(selectedCards);

  const matches = legal.filter(it => {
    const ids = it.play.cardIds;
    if(ids.length !== want.size) return false;
    for(const id of ids) if(!want.has(id)) return false;

    if(!selectedSquare) return false;

    const a = it.action;

    if(a.payload?.to === selectedSquare) return true;

    if(a.type === "NOBLE_BISHOP_BLOCK_CHECK"){
      return selectedSquare === a.payload.kingTo || selectedSquare === a.payload.followup.to;
    }

    if(a.type === "NOBLE_ROOK_SWAP"){
      const sqA = state.pieces[a.payload.pieceA].square;
      const sqB = state.pieces[a.payload.pieceB].square;
      return selectedSquare === sqA || selectedSquare === sqB;
    }

    if(a.type === "COMBO_NN"){
      if(a.payload.mode === "DOUBLE"){
        return a.payload.double.moves.some(mv => mv.to === selectedSquare);
      }
      return a.payload.split.a.to === selectedSquare || a.payload.split.b.to === selectedSquare;
    }

    return false;
  });

  if(matches.length >= 1){
    pendingIntent = matches[0]; // later we’ll add disambiguation UI
  }
}

function computeLegalForUI(){
  if(state.phase.stage === "SETUP"){
    const side = state.phase.setup.sideToPlace;
    const step = state.phase.setup.step;

    if(step === "PLACE_KING"){
      const backRank = side==="W" ? 1 : 8;
      const legal = [];
      for(const f of ["a","b","c","d","e","f","g","h"]){
        const to = `${f}${backRank}`;
        if(to === (side==="W"?"a1":"a8")) continue;
        if(to === (side==="W"?"h1":"h8")) continue;
        if(state.board[to]) continue;
        legal.push({ kind:"SETUP", side, action:{ type:"SETUP_PLACE_KING", payload:{ to } } });
      }
      return legal;
    }

    if(step === "PLACE_KNIGHTS"){
      const kid = `${side}_K`;
      const ksq = state.pieces[kid]?.square;
      if(!ksq) return [];
      const left = String.fromCharCode(ksq.charCodeAt(0)-1) + ksq[1];
      const right = String.fromCharCode(ksq.charCodeAt(0)+1) + ksq[1];
      if(state.board[left] || state.board[right]) return [];
      return [{
        kind:"SETUP",
        side,
        action:{ type:"SETUP_PLACE_KNIGHTS", payload:{ left, right } }
      }];
    }
    return [];
  }

  const side = state.phase.turn.side;
  if(isAIEnabled() && side !== "W") return [];
  return getLegalIntents(state, side);
}

function renderLog(){
  elLog.innerHTML = "";
  (state.log || []).slice(-30).forEach(e=>{
    const row = document.createElement("div");
    row.textContent = e.summary;
    elLog.appendChild(row);
  });
}

// boot
startNewGame();
