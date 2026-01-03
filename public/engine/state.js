import { now } from "./util.js";
import { buildDeckInstances } from "./cards.js";

export function createNewGameState({ mode="LIVE", vsAI=false, aiSide="B" } = {}) {
  const state = {
    meta: { version:"1.0", createdAt: now(), updatedAt: now() },
    config: { mode: vsAI ? "AI" : "LIVE", ai: { enabled: vsAI, level:"easy", side: aiSide } },
    players: { W:{ uid:null, name:"White" }, B:{ uid:null, name:"Black" } },

    phase: {
      stage: "SETUP",
      setup: { sideToPlace:"W", step:"PLACE_KING" },
      turn: { side:"W", step:"DRAW", extraTurnQueue:0 }
    },

    board: {},       // square -> pieceId
    pieces: {},      // pieceId -> piece
    cards: { W:{ deck:[], hand:[], discard:[] }, B:{ deck:[], hand:[], discard:[] } },
    cardInstances: {},

    threat: { inCheck:{ W:false, B:false }, lastMove:null },
    result: { status:"ONGOING", winner:null, reason:null },
    log: []
  };

  initPieces(state);
  initCards(state);
  return state;
}

function initPieces(state){
  // Standard chess inventory only
  const mk = (side, type, n=null) => `${side}_${type}${n??""}`.replace("__","_");
  const add = (id, side, type) => {
    state.pieces[id] = { id, side, type, status:"INACTIVE", square:null };
  };

  ["W","B"].forEach(side=>{
    add(mk(side,"K"), side, "K");
    add(mk(side,"Q"), side, "Q");
    add(mk(side,"R","1"), side, "R");
    add(mk(side,"R","2"), side, "R");
    add(mk(side,"B","1"), side, "B");
    add(mk(side,"B","2"), side, "B");
    add(mk(side,"N","1"), side, "N");
    add(mk(side,"N","2"), side, "N");
    for(let i=1;i<=8;i++) add(mk(side,"P",String(i)), side, "P");
  });
}

function initCards(state){
  // Build per-side card instances based on the rules deck split:
  // 16 Knight, 8 Pawn, 5 King, 1 Rook, 1 Queen, 1 Bishop per player. :contentReference[oaicite:1]{index=1}
  const { instancesW, instancesB } = buildDeckInstances();
  state.cardInstances = { ...instancesW, ...instancesB };

  state.cards.W.deck = Object.keys(instancesW);
  state.cards.B.deck = Object.keys(instancesB);

  // Shuffle decks client-side for AI/offline; for live mode, server should reshuffle at game creation.
  shuffleInPlace(state.cards.W.deck);
  shuffleInPlace(state.cards.B.deck);
}

export function shuffleInPlace(arr){
  for(let i=arr.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]] = [arr[j],arr[i]];
  }
}
