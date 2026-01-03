import { clone, now, assert, otherSide, fileOf, rankOf, inBounds, sq } from "./util.js";
import { FILES, generateMovesStandard, isInCheck } from "./moves.js";
import { shuffleInPlace } from "./state.js";

/**
 * Exports used by the browser client (app.js):
 * - getLegalIntents(state, side)
 * - applyIntent(state, intent)
 * - evaluateGame(state)
 *
 * Internal/engine exports kept:
 * - applyIntentStrict(state,intent)
 * - serverAdvanceDrawPhase(state)
 */

// Compatibility exports for app.js (browser client)
// app.js imports { getLegalIntents, applyIntent, evaluateGame }.
// The engine core function is applyIntentStrict; expose applyIntent as an alias.
export function applyIntent(state, intent) {
  return applyIntentStrict(state, intent);
}

// Minimal game evaluation used by the UI/AI loop.
// Game ends immediately when a king is captured (ruthless rule).
export function evaluateGame(state) {
  const pieces = state?.pieces ? Object.values(state.pieces) : [];
  const wK = pieces.find(p => p && p.side === "W" && p.type === "K" && p.status === "ACTIVE");
  const bK = pieces.find(p => p && p.side === "B" && p.type === "K" && p.status === "ACTIVE");

  if (!wK && !bK) return { status: "ENDED", winner: null, reason: "Both kings captured" };
  if (!wK) return { status: "ENDED", winner: "B", reason: "White king captured" };
  if (!bK) return { status: "ENDED", winner: "W", reason: "Black king captured" };

  return { status: "ONGOING", winner: null, reason: null };
}

export function applyIntentStrict(state, intent) {
  const s = clone(state);
  validateIntent(s, intent);
  applyIntentMut(s, intent);
  s.meta.updatedAt = now();
  return s;
}

export function drawToEight(state, side) {
  // Draw until side has 8 cards in hand
  const s = clone(state);
  while ((s.hands[side] || []).length < 8) {
    const next = s.decks[side].shift();
    if (!next) break;
    s.hands[side].push(next);
  }
  return s;
}

export function serverAdvanceDrawPhase(state) {
  const s = clone(state);
  const turn = s.phase.turn;
  const side = turn.side;

  // Already in PLAY? nothing to do
  if (turn.step === "PLAY") return s;

  // DRAW step -> draw to 8 then move to PLAY
  if (turn.step === "DRAW") {
    // draw
    while ((s.hands[side] || []).length < 8) {
      const next = s.decks[side].shift();
      if (!next) break;
      s.hands[side].push(next);
    }
    turn.step = "PLAY";

    // update check flags (for UI)
    s.threat.inCheck.W = isInCheck(s, "W");
    s.threat.inCheck.B = isInCheck(s, "B");
  }

  return s;
}

/* ------------------ Intent validation + application ------------------ */

function validateIntent(state, intent) {
  assert(intent && intent.side, "Missing intent.side");
  assert(intent.action && intent.action.type, "Missing intent.action.type");

  const side = intent.side;

  // must be current side during TURN stage
  if (state.phase.stage === "TURN") {
    assert(state.phase.turn.side === side, "Not your turn");
    assert(state.phase.turn.step === "PLAY", "Not in PLAY step");
  }

  // Setup stages, if any
  if (state.phase.stage === "SETUP") {
    validateSetupIntent(state, intent);
    return;
  }

  // Cards must match hand
  if (intent.play?.cardIds?.length) {
    for (const cid of intent.play.cardIds) {
      assert((state.hands[side] || []).includes(cid), "Card not in hand");
    }
  }

  // Action-specific checks
  const a = intent.action;

  if (a.type === "PLACE") {
    const { pieceId, to } = a.payload;
    assert(pieceId && to, "PLACE requires pieceId/to");
    const p = state.pieces[pieceId];
    assert(p && p.side === side, "Bad pieceId");
    assert(p.status === "IN_HAND", "Piece not in hand");
    assert(!state.board[to], "Square occupied");
    return;
  }

  if (
    a.type === "MOVE_STANDARD" ||
    a.type === "NOBLE_QUEEN_MOVE_EXTRA_TURN" ||
    a.type === "NOBLE_KING_ADJ_NO_CAPTURE"
  ) {
    const { pieceId, to } = a.payload;
    assert(pieceId && to, "MOVE requires pieceId/to");
    const p = state.pieces[pieceId];
    assert(p && p.side === side, "Bad pieceId");
    assert(p.status === "ACTIVE", "Piece not active");
    assert(p.square, "Piece not on board");
    return;
  }

  // Most combos/nobles do deeper checking in their generators;
  // still require payload present
  if (a.type.startsWith("NOBLE_") || a.type.startsWith("COMBO_")) {
    assert(a.payload != null, "Missing action.payload");
  }
}

function validateSetupIntent(state, intent) {
  const { step, sideToPlace } = state.phase.setup;

  assert(intent.kind === "SETUP", "Setup intent required");
  assert(intent.side === sideToPlace, "Wrong side to place");

  const { action } = intent;

  if (step === "PLACE_KING") {
    assert(action.type === "SETUP_PLACE_KING", "Expected king placement");
    const { to } = action.payload;
    const backRank = intent.side === "W" ? 1 : 8;
    assert(Number(to[1]) === backRank, "King must be on back rank");
    assert(
      to !== (intent.side === "W" ? "a1" : "a8") && to !== (intent.side === "W" ? "h1" : "h8"),
      "King cannot be in a corner"
    );
    assert(!state.board[to], "Square occupied");
    return;
  }

  if (step === "PLACE_KNIGHTS") {
    assert(action.type === "SETUP_PLACE_KNIGHTS", "Expected knight placement");
    const { toA, toB } = action.payload;
    assert(toA && toB, "Need toA/toB");
    const backRank = intent.side === "W" ? 1 : 8;
    assert(Number(toA[1]) === backRank && Number(toB[1]) === backRank, "Knights must be on back rank");
    assert(toA !== toB, "Knights must be distinct squares");
    assert(!state.board[toA] && !state.board[toB], "Square occupied");
    return;
  }

  if (step === "DONE") {
    throw new Error("Setup already done");
  }
}

function applyIntentMut(state, intent) {
  const side = intent.side;

  // remove played cards from hand
  if (intent.play?.cardIds?.length) {
    for (const cid of intent.play.cardIds) {
      const idx = state.hands[side].indexOf(cid);
      if (idx >= 0) state.hands[side].splice(idx, 1);
      state.discard[side].push(cid);
    }
  }

  // setup handling
  if (state.phase.stage === "SETUP") {
    applySetupMut(state, intent);
    return;
  }

  const terminal = applyAction(state, intent);

  if (!terminal) {
    state.threat.inCheck.W = isInCheck(state, "W");
    state.threat.inCheck.B = isInCheck(state, "B");

    // Standard rule: cannot end leaving your king in check
    // (except if you captured the enemy king, which would be terminal already).
    if (state.threat.inCheck[side]) {
      throw new Error("Illegal: ended turn in check");
    }
  }

  // Turn advance
  if (!terminal) {
    const turn = state.phase.turn;

    if (intent.action.type === "NOBLE_QUEEN_MOVE_EXTRA_TURN") {
      // Queen noble grants another full turn sequence
      turn.extraTurnQueue += 1;
    }

    if (turn.extraTurnQueue > 0) {
      turn.extraTurnQueue -= 1;
      turn.step = "DRAW";
    } else {
      turn.side = otherSide(turn.side);
      turn.step = "DRAW";
    }
  } else {
    state.phase.stage = "ENDED";
    state.result = {
      status: "ENDED",
      winner: side,
      reason: "King captured",
    };
  }
}

function applySetupMut(state, intent) {
  const side = intent.side;
  const setup = state.phase.setup;

  if (setup.step === "PLACE_KING") {
    const kingId = findPieceInHand(state, side, "K");
    placePiece(state, kingId, intent.action.payload.to);
    setup.step = "PLACE_KNIGHTS";
    return;
  }

  if (setup.step === "PLACE_KNIGHTS") {
    const ks = Object.values(state.pieces).filter((p) => p.side === side && p.type === "N" && p.status === "IN_HAND");
    assert(ks.length >= 2, "Not enough knights in hand");
    placePiece(state, ks[0].id, intent.action.payload.toA);
    placePiece(state, ks[1].id, intent.action.payload.toB);

    // next side to place, or done
    if (setup.sideToPlace === "W") {
      setup.sideToPlace = "B";
      setup.step = "PLACE_KING";
    } else {
      setup.step = "DONE";
      state.phase.stage = "TURN";
      state.phase.turn = { side: "W", step: "DRAW", extraTurnQueue: 0 };

      // shuffle decks at start
      shuffleInPlace(state.decks.W);
      shuffleInPlace(state.decks.B);

      // initial draw
      state = Object.assign(state, serverAdvanceDrawPhase(state));
    }
  }
}

function applyAction(state, intent) {
  const a = intent.action;

  switch (a.type) {
    case "PLACE": {
      const { pieceId, to } = a.payload;
      placePiece(state, pieceId, to);
      return false;
    }

    case "MOVE_STANDARD":
    case "NOBLE_QUEEN_MOVE_EXTRA_TURN": {
      const { pieceId, to } = a.payload;
      return movePiece(state, intent.side, pieceId, to);
    }

    case "NOBLE_KING_ADJ_NO_CAPTURE": {
      const { pieceId, to } = a.payload;
      return movePiece(state, intent.side, pieceId, to, { forbidCapture: true });
    }

    case "NOBLE_ROOK_SWAP": {
      const A = state.pieces[a.payload.pieceA];
      const B = state.pieces[a.payload.pieceB];
      const sqA = A.square, sqB = B.square;
      state.board[sqA] = B.id; B.square = sqA;
      state.board[sqB] = A.id; A.square = sqB;
      return false;
    }

    case "COMBO_NN": {
      const p = a.payload;

      if (p.mode === "DOUBLE") {
        const { pieceId, moves } = p.double;
        assert(moves && moves.length === 2, "DOUBLE needs 2 moves");
        let terminal = false;
        terminal = movePiece(state, intent.side, pieceId, moves[0].to) || terminal;
        if (terminal) return true;
        terminal = movePiece(state, intent.side, pieceId, moves[1].to) || terminal;
        return terminal;
      }

      if (p.mode === "SPLIT") {
        const A = p.split.a;
        const B = p.split.b;
        let terminal = false;
        terminal = movePiece(state, intent.side, A.pieceId, A.to) || terminal;
        if (terminal) return true;
        terminal = movePiece(state, intent.side, B.pieceId, B.to) || terminal;
        return terminal;
      }

      throw new Error("Unknown COMBO_NN mode");
    }

    case "COMBO_NX_MORPH": {
      const { otherKind, move } = a.payload;
      // Move is performed by a knight but using other piece's movement pattern
      return movePiece(state, intent.side, move.pieceId, move.to);
    }

    default:
      throw new Error("Unknown action type: " + a.type);
  }
}

/* ------------------ Legal intents generator ------------------ */

export function getLegalIntents(state, side) {
  if (state.phase.stage === "ENDED") return [];

  // Setup stage intents
  if (state.phase.stage === "SETUP") {
    return getSetupIntents(state, side);
  }

  // Turn stage gating
  if (state.phase.stage === "TURN") {
    if (state.phase.turn.side !== side) return [];
    if (state.phase.turn.step !== "PLAY") return [];
  }

  const intents = [];

  const hand = state.hands[side] || [];
  for (const cid of hand) {
    intents.push(...genSingle(state, side, cid));
  }

  // combos: all unordered pairs from hand
  for (let i = 0; i < hand.length; i++) {
    for (let j = i + 1; j < hand.length; j++) {
      intents.push(...genCombo(state, side, hand[i], hand[j]));
    }
  }

  // If in check, filter to only intents that resolve check
  if (state.threat?.inCheck?.[side]) {
    return intents.filter((it) => resolvesCheckOrCapturesKing(state, it));
  }

  return intents;
}

function resolvesCheckOrCapturesKing(state, intent) {
  try {
    const after = applyIntentStrict(state, intent);

    // If we captured enemy king, always allowed (your rule)
    if (after.phase.stage === "ENDED") return true;

    // Otherwise must not be in check after
    return !after.threat.inCheck[intent.side];
  } catch {
    return false;
  }
}

function getSetupIntents(state, side) {
  const s = state.phase.setup;
  if (s.sideToPlace !== side) return [];

  const out = [];

  if (s.step === "PLACE_KING") {
    const backRank = side === "W" ? 1 : 8;
    for (const f of FILES) {
      const to = `${f}${backRank}`;
      if (to === (side === "W" ? "a1" : "a8")) continue;
      if (to === (side === "W" ? "h1" : "h8")) continue;
      if (state.board[to]) continue;
      out.push({
        kind: "SETUP",
        side,
        action: { type: "SETUP_PLACE_KING", payload: { to } },
      });
    }
    return out;
  }

  if (s.step === "PLACE_KNIGHTS") {
    const backRank = side === "W" ? 1 : 8;
    const squares = FILES.map((f) => `${f}${backRank}`).filter((sq) => !state.board[sq]);

    for (let i = 0; i < squares.length; i++) {
      for (let j = i + 1; j < squares.length; j++) {
        out.push({
          kind: "SETUP",
          side,
          action: { type: "SETUP_PLACE_KNIGHTS", payload: { toA: squares[i], toB: squares[j] } },
        });
      }
    }
    return out;
  }

  return out;
}

/* ------------------ Single / Combo generators ------------------ */

function genSingle(state, side, cardId) {
  const kind = state.cards?.[cardId]?.kind || state.deck?.[cardId]?.kind || state.cardMeta?.[cardId]?.kind;

  // Knight: standard chess move permission
  if (kind === "KNIGHT") {
    return genMoveStandardForAny(state, side, { type: "SINGLE", cardIds: [cardId] });
  }

  // Pawn: standard pawn move permission (piece-only)
  if (kind === "PAWN") {
    return genPawnStandard(state, side, { type: "SINGLE", cardIds: [cardId] });
  }

  // Others single: either PLACE or NOBLE (depending on what’s possible)
  const out = [];
  out.push(...genPlace(state, side, cardId));

  if (kind === "KING") out.push(...genNobleKing(state, side, cardId));
  if (kind === "ROOK") out.push(...genNobleRook(state, side, cardId));
  if (kind === "QUEEN") out.push(...genNobleQueen(state, side, cardId));
  if (kind === "BISHOP") out.push(...genNobleBishop(state, side, cardId));

  return out;
}

function genCombo(state, side, a, b) {
  const ka = cardKind(state, a);
  const kb = cardKind(state, b);

  const cardIds = [a, b];

  // NN combo
  if (ka === "KNIGHT" && kb === "KNIGHT") {
    return genComboNN(state, side, cardIds);
  }

  // Knight + non-knight => combo permissions (move knight as that piece, or allow that piece move)
  if (ka === "KNIGHT" && kb !== "KNIGHT") {
    return genComboNX(state, side, cardIds, kb);
  }
  if (kb === "KNIGHT" && ka !== "KNIGHT") {
    return genComboNX(state, side, cardIds, ka);
  }

  return [];
}

/* ------------------ Card kind helpers ------------------ */

function cardKind(state, cardId) {
  return state.cards?.[cardId]?.kind || state.deck?.[cardId]?.kind || state.cardMeta?.[cardId]?.kind;
}

/* ------------------ PLACE generation ------------------ */

function genPlace(state, side, cardId) {
  const kind = cardKind(state, cardId);
  // Find a piece in hand matching kind
  const piece = Object.values(state.pieces).find((p) => p.side === side && p.type === kindToPieceType(kind) && p.status === "IN_HAND");
  if (!piece) return [];

  const out = [];
  for (const sqr of allSquares()) {
    if (state.board[sqr]) continue;
    out.push({
      kind: "TURN",
      side,
      play: { type: "SINGLE", cardIds: [cardId] },
      action: { type: "PLACE", payload: { pieceId: piece.id, to: sqr } },
    });
  }
  return out;
}

function kindToPieceType(kind) {
  if (kind === "KNIGHT") return "N";
  if (kind === "BISHOP") return "B";
  if (kind === "ROOK") return "R";
  if (kind === "QUEEN") return "Q";
  if (kind === "KING") return "K";
  if (kind === "PAWN") return "P";
  return kind;
}

/* ------------------ Standard moves (Knight card, Pawn card) ------------------ */

function genMoveStandardForAny(state, side, play) {
  const out = [];
  const pieces = Object.values(state.pieces).filter((p) => p.side === side && p.status === "ACTIVE" && p.square);
  for (const p of pieces) {
    const moves = generateMovesStandard(state, p.id);
    for (const to of moves) {
      out.push({
        kind: "TURN",
        side,
        play,
        action: { type: "MOVE_STANDARD", payload: { pieceId: p.id, to } },
      });
    }
  }
  return out;
}

function genPawnStandard(state, side, play) {
  const out = [];
  const pawns = Object.values(state.pieces).filter((p) => p.side === side && p.status === "ACTIVE" && p.type === "P" && p.square);
  for (const p of pawns) {
    const moves = generateMovesStandard(state, p.id);
    for (const to of moves) {
      out.push({
        kind: "TURN",
        side,
        play,
        action: { type: "MOVE_STANDARD", payload: { pieceId: p.id, to } },
      });
    }
  }
  return out;
}

/* ------------------ Noble abilities ------------------ */

function genNobleKing(state, side, cardId) {
  const out = [];
  const king = Object.values(state.pieces).find((p) => p.side === side && p.type === "K" && p.status === "ACTIVE");
  if (!king) return out;

  const from = king.square;
  const deltas = [
    [1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]
  ];
  for (const [df, dr] of deltas) {
    const f = fileOf(from).charCodeAt(0) + df;
    const r = rankOf(from) + dr;
    const nf = String.fromCharCode(f);
    if (!inBounds(nf, r)) continue;
    const to = sq(nf, r);
    if (!state.board[to]) {
      out.push({
        kind: "TURN",
        side,
        play: { type: "SINGLE", cardIds: [cardId] },
        action: { type: "NOBLE_KING_ADJ_NO_CAPTURE", payload: { pieceId: king.id, to } },
      });
    }
  }
  return out;
}

function genNobleRook(state, side, cardId) {
  const out = [];
  const rooks = Object.values(state.pieces).filter((p) => p.side === side && p.type === "R" && p.status === "ACTIVE" && p.square);
  const nonPawns = Object.values(state.pieces).filter((p) => p.side === side && p.type !== "P" && p.status === "ACTIVE" && p.square);

  for (const r of rooks) {
    for (const other of nonPawns) {
      if (other.id === r.id) continue;
      out.push({
        kind: "TURN",
        side,
        play: { type: "SINGLE", cardIds: [cardId] },
        action: { type: "NOBLE_ROOK_SWAP", payload: { pieceA: r.id, pieceB: other.id } },
      });
    }
  }
  return out;
}

function genNobleQueen(state, side, cardId) {
  const out = [];
  const queens = Object.values(state.pieces).filter((p) => p.side === side && p.type === "Q" && p.status === "ACTIVE" && p.square);
  for (const q of queens) {
    const moves = generateMovesStandard(state, q.id);
    for (const to of moves) {
      out.push({
        kind: "TURN",
        side,
        play: { type: "SINGLE", cardIds: [cardId] },
        action: { type: "NOBLE_QUEEN_MOVE_EXTRA_TURN", payload: { pieceId: q.id, to } },
      });
    }
  }
  return out;
}

function genNobleBishop(state, side, cardId) {
  // If you have a bishop noble defined elsewhere, keep it.
  // This placeholder does nothing extra unless you already defined bishop noble rules.
  return [];
}

/* ------------------ Combos ------------------ */

function genComboNN(state, side, cardIds) {
  const out = [];
  const knights = Object.values(state.pieces).filter((p) => p.side === side && p.status === "ACTIVE" && p.type === "N" && p.square);
  if (!knights.length) return out;

  // DOUBLE: same knight moves twice (using standard knight moves both times)
  for (const n of knights) {
    const firsts = generateMovesStandard(state, n.id);
    for (const to1 of firsts) {
      // simulate first
      const tmp = applyIntentStrict(state, {
        kind: "TURN",
        side,
        play: { type: "COMBO", cardIds },
        action: { type: "MOVE_STANDARD", payload: { pieceId: n.id, to: to1 } },
      });

      if (tmp.phase.stage === "ENDED") {
        // capturing king on first move ends game; still legal
        out.push({
          kind: "TURN",
          side,
          play: { type: "COMBO", cardIds },
          action: {
            type: "COMBO_NN",
            payload: { mode: "DOUBLE", double: { pieceId: n.id, moves: [{ to: to1 }, { to: to1 }] } },
          },
        });
        continue;
      }

      const seconds = generateMovesStandard(tmp, n.id);
      for (const to2 of seconds) {
        out.push({
          kind: "TURN",
          side,
          play: { type: "COMBO", cardIds },
          action: {
            type: "COMBO_NN",
            payload: { mode: "DOUBLE", double: { pieceId: n.id, moves: [{ to: to1 }, { to: to2 }] } },
          },
        });
      }
    }
  }

  // SPLIT: two different knights move once each
  for (let i = 0; i < knights.length; i++) {
    for (let j = i + 1; j < knights.length; j++) {
      const A = knights[i], B = knights[j];
      const movesA = generateMovesStandard(state, A.id);
      const movesB = generateMovesStandard(state, B.id);

      for (const toA of movesA) {
        for (const toB of movesB) {
          out.push({
            kind: "TURN",
            side,
            play: { type: "COMBO", cardIds },
            action: {
              type: "COMBO_NN",
              payload: { mode: "SPLIT", split: { a: { pieceId: A.id, to: toA }, b: { pieceId: B.id, to: toB } } },
            },
          });
        }
      }
    }
  }

  return out;
}

function genComboNX(state, side, cardIds, otherKind) {
  // “Knight + X” combo.
  // Two common interpretations:
  // - Move one of your knights using X-movement rules (morph)
  // - Or move X like normal (depends on your full rules)
  // Your existing code appears to implement a morph style.
  const out = [];

  const knights = Object.values(state.pieces).filter(
    (p) => p.side === side && p.status === "ACTIVE" && p.type === "N" && p.square
  );

  for (const n of knights) {
    const from = n.square;
    for (const to of genAsOtherDests(state, from, side, otherKind)) {
      out.push({
        kind: "TURN",
        side,
        play: { type: "COMBO", cardIds },
        action: {
          type: "COMBO_NX_MORPH",
          payload: {
            otherKind,
            move: { pieceId: n.id, to },
          },
        },
      });
    }
  }

  return out;
}

function genAsOtherDests(state, from, side, otherKind) {
  // Generate squares reachable from `from` using the movement pattern of otherKind.
  // This is for NX morph.
  if (otherKind === "ROOK") return genRayDests(state, from, side, [[1,0],[-1,0],[0,1],[0,-1]]);
  if (otherKind === "BISHOP") return genRayDests(state, from, side, [[1,1],[1,-1],[-1,1],[-1,-1]]);
  if (otherKind === "QUEEN") return genRayDests(state, from, side, [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]);
  if (otherKind === "KING") {
    const out = [];
    const deltas = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
    for (const [df, dr] of deltas) {
      const nf = String.fromCharCode(fileOf(from).charCodeAt(0) + df);
      const nr = rankOf(from) + dr;
      if (!inBounds(nf, nr)) continue;
      const to = sq(nf, nr);
      const occId = state.board[to];
      if (!occId) out.push(to);
      else {
        const occ = state.pieces[occId];
        if (occ.side !== side) out.push(to);
      }
    }
    return out;
  }
  return [];
}

function genRayDests(state, from, side, dirs) {
  const out = [];
  for (const [df, dr] of dirs) {
    let f = fileOf(from).charCodeAt(0);
    let r = rankOf(from);
    while (true) {
      f += df;
      r += dr;
      const nf = String.fromCharCode(f);
      if (!inBounds(nf, r)) break;
      const to = sq(nf, r);
      const occId = state.board[to];
      if (!occId) {
        out.push(to);
        continue;
      }
      const occ = state.pieces[occId];
      if (occ.side !== side) out.push(to);
      break;
    }
  }
  return out;
}

/* ------------------ Low-level board mutations ------------------ */

function placePiece(state, pieceId, to) {
  const p = state.pieces[pieceId];
  assert(p.status === "IN_HAND", "placePiece: not in hand");
  assert(!state.board[to], "placePiece: occupied");
  p.status = "ACTIVE";
  p.square = to;
  state.board[to] = pieceId;
}

function movePiece(state, moverSide, pieceId, to, opts = {}) {
  const p = state.pieces[pieceId];
  const from = p.square;
  const targetId = state.board[to];

  if (targetId) {
    const t = state.pieces[targetId];
    if (opts.forbidCapture) throw new Error("Capture forbidden");
    if (t.side === moverSide) throw new Error("Cannot capture own piece");

    t.status = "CAPTURED";
    t.square = null;
    delete state.board[to];

    if (t.type === "K") {
      // King captured ends game immediately
      delete state.board[from];
      state.board[to] = p.id;
      p.square = to;
      return true;
    }
  }

  delete state.board[from];
  state.board[to] = p.id;
  p.square = to;
  return false;
}

function findPieceInHand(state, side, type) {
  const p = Object.values(state.pieces).find((x) => x.side === side && x.type === type && x.status === "IN_HAND");
  assert(p, `No ${type} in hand for ${side}`);
  return p.id;
}

function allSquares() {
  const out = [];
  for (let r = 1; r <= 8; r++) {
    for (const f of FILES) out.push(`${f}${r}`);
  }
  return out;
}
