import { now } from "./util.js";
import { buildDeckInstances } from "./cards.js";

/**
 * In-place shuffle (Fisher–Yates)
 */
export function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/**
 * IMPORTANT:
 * app.js imports `newGameState`, so we export that name.
 * Internally we keep createNewGameState for clarity.
 */
export function newGameState(opts = {}) {
  return createNewGameState(opts);
}

export function createNewGameState({ vsAI = false, aiSide = "B" } = {}) {
  const state = {
    meta: { version: "1.0", createdAt: now(), updatedAt: now() },

    config: {
      mode: vsAI ? "AI" : "OFFLINE",
      ai: { enabled: vsAI, level: "easy", side: aiSide }
    },

    players: { W: { uid: null, name: "White" }, B: { uid: null, name: "Black" } },

    // Engine expects phase.stage === "SETUP" then "TURN"
    phase: {
      stage: "SETUP",
      setup: { sideToPlace: "W", step: "PLACE_KING" },
      turn: { side: "W", step: "DRAW", extraTurnQueue: 0 }
    },

    // Board: { "e4": "W_N1", ... }
    board: {},

    // Pieces: id -> {id, side, type, status, square}
    pieces: {},

    /**
     * Card system MUST match rules.js + app.js expectations:
     * - state.decks[side]   : array of cardIds
     * - state.hands[side]   : array of cardIds
     * - state.discard[side] : array of cardIds
     * - state.cardInstances : cardId -> meta (includes kind, side, etc.)
     */
    decks: { W: [], B: [] },
    hands: { W: [], B: [] },
    discard: { W: [], B: [] },
    cardInstances: {},

    // Optional: some parts of rules.js look at state.cardMeta
    cardMeta: {},

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
    // CRITICAL: rules.js PLACE validation expects pieces start as IN_HAND (not INACTIVE)
    state.pieces[id] = { id, side, type, status: "IN_HAND", square: null };
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

  // Card instances meta keyed by cardId
  state.cardInstances = { ...instancesW, ...instancesB };

  // Also expose under cardMeta for any older lookups
  state.cardMeta = state.cardInstances;

  // Decks are arrays of cardIds
  state.decks.W = Object.keys(instancesW);
  state.decks.B = Object.keys(instancesB);

  shuffleInPlace(state.decks.W);
  shuffleInPlace(state.decks.B);

  // Hands/discard start empty
  state.hands.W = [];
  state.hands.B = [];
  state.discard.W = [];
  state.discard.B = [];
}
