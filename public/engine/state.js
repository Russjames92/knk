import { now } from "./util.js";
import { buildDeckInstances } from "./cards.js";

export function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

export function createNewGameState({ vsAI = false, aiSide = "B" } = {}) {
  const state = {
    meta: { version: "1.0", createdAt: now(), updatedAt: now() },
    config: { mode: vsAI ? "AI" : "OFFLINE", ai: { enabled: vsAI, level: "easy", side: aiSide } },
    players: { W: { uid: null, name: "White" }, B: { uid: null, name: "Black" } },

    phase: {
      stage: "SETUP",
      setup: { sideToPlace: "W", step: "PLACE_KING" },
      turn: { side: "W", step: "DRAW", extraTurnQueue: 0 }
    },

    board: {},
    pieces: {},

    cards: { W: { deck: [], hand: [], discard: [] }, B: { deck: [], hand: [], discard: [] } },
    cardInstances: {},

    threat: { inCheck: { W: false, B: false }, lastMove: null },
    result: { status: "ONGOING", winner: null, reason: null },
    log: []
  };

  initPieces(state);
  initCards(state);
  return state;
}

function initPieces(state) {
  const mk = (side, type, n = null) => `${side}_${type}${n ?? ""}`.replace("__", "_");
  const add = (id, side, type) => {
    state.pieces[id] = { id, side, type, status: "INACTIVE", square: null };
  };

  ["W", "B"].forEach((side) => {
    add(mk(side, "K"), side, "K");
    add(mk(side, "Q"), side, "Q");
    add(mk(side, "R", "1"), side, "R");
    add(mk(side, "R", "2"), side, "R");
    add(mk(side, "B", "1"), side, "B");
    add(mk(side, "B", "2"), side, "B");
    add(mk(side, "N", "1"), side, "N");
    add(mk(side, "N", "2"), side, "N");
    for (let i = 1; i <= 8; i++) add(mk(side, "P", String(i)), side, "P");
  });
}

function initCards(state) {
  const { instancesW, instancesB } = buildDeckInstances();
  state.cardInstances = { ...instancesW, ...instancesB };

  state.cards.W.deck = Object.keys(instancesW);
  state.cards.B.deck = Object.keys(instancesB);

  shuffleInPlace(state.cards.W.deck);
  shuffleInPlace(state.cards.B.deck);
}
