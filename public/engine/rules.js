import { clone, now, assert, otherSide } from "./util.js";
import { FILES, generateMovesStandard, isInCheck } from "./moves.js";
import { shuffleInPlace } from "./state.js";

/**
 * Public exports required by app.js:
 * - applyIntentStrict(state,intent)
 * - serverAdvanceDrawPhase(state)
 * - getLegalIntents(state, side)
 */

export function applyIntentStrict(state, intent) {
  const s = clone(state);
  validateIntent(s, intent);
  applyIntentMut(s, intent);
  s.meta.updatedAt = now();
  return s;
}

function validateIntent(state, intent) {
  assert(state.result.status === "ONGOING", "Game over");
  assert(intent && intent.side, "Bad intent");

  if (intent.kind === "SETUP") {
    return validateSetup(state, intent);
  }

  assert(state.phase.stage === "TURN", "Not in TURN phase");
  assert(state.phase.turn.side === intent.side, "Not your turn");
  assert(state.phase.turn.step === "PLAY", "Expected PLAY intents only (DRAW handled automatically)");

  assert(intent.play && intent.action, "Missing play/action");
  validateCardPlay(state, intent);
  validateAction(state, intent);
}

function validateSetup(state, intent) {
  assert(state.phase.stage === "SETUP", "Not in setup");
  const side = state.phase.setup.sideToPlace;
  assert(intent.side === side, "Wrong side for setup");
  const { step } = state.phase.setup;
  const { action } = intent;

  if (step === "PLACE_KING") {
    assert(action.type === "SETUP_PLACE_KING", "Expected king placement");
    const { to } = action.payload;
    const backRank = side === "W" ? 1 : 8;
    assert(Number(to[1]) === backRank, "King must be on back rank");
    assert(to !== (side === "W" ? "a1" : "a8") && to !== (side === "W" ? "h1" : "h8"), "King cannot be in a corner");
    assert(!state.board[to], "Square occupied");
    return;
  }

  if (step === "PLACE_KNIGHTS") {
    assert(action.type === "SETUP_PLACE_KNIGHTS", "Expected knight placement");
    const { left, right } = action.payload;
    const kingSq = state.pieces[`${side}_K`]?.square;
    assert(kingSq, "King must be placed first");
    const bf = kingSq[0], br = kingSq[1];
    const leftExpected = String.fromCharCode(bf.charCodeAt(0) - 1) + br;
    const rightExpected = String.fromCharCode(bf.charCodeAt(0) + 1) + br;
    assert(left === leftExpected && right === rightExpected, "Knights must be adjacent to king");
    assert(!state.board[left] && !state.board[right], "Square occupied");
    return;
  }

  throw new Error("Unknown setup step");
}

function validateCardPlay(state, intent) {
  const side = intent.side;
  const hand = state.cards[side].hand;
  const cardIds = intent.play.cardIds || [];
  assert(cardIds.length === 1 || cardIds.length === 2, "Must play 1 card or 2-card combo");

  for (const cid of cardIds) {
    assert(hand.includes(cid), "Card not in hand");
    assert(state.cardInstances[cid]?.owner === side, "Not your card");
  }

  if (cardIds.length === 2) {
    const kinds = cardIds.map((cid) => state.cardInstances[cid].kind);
    assert(!kinds.includes("PAWN"), "Pawn cards cannot be in combos");
    const knightCount = kinds.filter((k) => k === "KNIGHT").length;
    assert(knightCount >= 1, "Combo must include a knight");
    if (knightCount === 1) {
      const other = kinds.find((k) => k !== "KNIGHT");
      assert(["KING", "ROOK", "QUEEN", "BISHOP"].includes(other), "Invalid combo partner");
    }
  }
}

function validateAction(state, intent) {
  const a = intent.action;
  switch (a.type) {
    case "PLACE": return validatePlace(state, intent);
    case "MOVE_STANDARD": return validateMoveStandard(state, intent);
    case "NOBLE_KING_ADJ_NO_CAPTURE": return validateNobleKing(state, intent);
    case "NOBLE_ROOK_SWAP": return validateNobleRook(state, intent);
    case "NOBLE_QUEEN_MOVE_EXTRA_TURN": return validateMoveStandard(state, intent);
    case "NOBLE_BISHOP_RESURRECT": return validateResurrect(state, intent);
    case "NOBLE_BISHOP_BLOCK_CHECK": return validateBishopBlockCheck(state, intent);
    case "COMBO_NN": return validateComboNN(state, intent);
    case "COMBO_NX_MORPH": return validateComboMorph(state, intent);
    default: throw new Error("Unknown action type");
  }
}

function validatePlace(state, intent) {
  const { pieceId, to } = intent.action.payload;
  const p = state.pieces[pieceId];
  assert(p && p.side === intent.side, "Bad piece");
  assert(p.status === "INACTIVE", "Piece not available");
  assert(!state.board[to], "Square occupied");

  const rank = Number(to[1]);
  const backRank = intent.side === "W" ? 1 : 8;
  const secondRank = intent.side === "W" ? 2 : 7;
  if (p.type === "P") assert(rank === secondRank, "Pawn must be placed on second rank");
  else assert(rank === backRank, "Non-pawn must be placed on back rank");
}

function validateMoveStandard(state, intent) {
  const { pieceId, from, to } = intent.action.payload;
  const p = state.pieces[pieceId];
  assert(p && p.side === intent.side, "Bad piece");
  assert(p.status === "ACTIVE", "Piece not active");
  assert(p.square === from, "From mismatch");
  const legal = generateMovesStandard(state, pieceId).some((m) => m.to === to);
  assert(legal, "Illegal move");
}

function validateNobleKing(state, intent) {
  const { pieceId, from, to } = intent.action.payload;
  const p = state.pieces[pieceId];
  assert(p && p.side === intent.side, "Bad piece");
  assert(p.status === "ACTIVE", "Piece not active");
  assert(p.type !== "P", "Cannot target pawn");
  assert(p.square === from, "From mismatch");
  assert(!state.board[to], "Noble King cannot capture");

  const df = Math.abs(to.charCodeAt(0) - from.charCodeAt(0));
  const dr = Math.abs(Number(to[1]) - Number(from[1]));
  assert(df <= 1 && dr <= 1 && (df + dr > 0), "Must move to adjacent square");
}

function validateNobleRook(state, intent) {
  const { pieceA, pieceB } = intent.action.payload;
  const a = state.pieces[pieceA], b = state.pieces[pieceB];
  assert(a && b, "Missing pieces");
  assert(a.side === intent.side && b.side === intent.side, "Wrong side");
  assert(a.status === "ACTIVE" && b.status === "ACTIVE", "Both must be active");
  assert(a.type !== "P" && b.type !== "P", "Cannot swap pawns");
}

function validateResurrect(state, intent) {
  const { pieceId, to } = intent.action.payload;
  const p = state.pieces[pieceId];
  assert(p && p.side === intent.side, "Bad piece");
  assert(p.status === "CAPTURED", "Must be captured");
  assert(p.type !== "K", "Cannot resurrect king");
  assert(p.type !== "P", "Cannot resurrect pawns here");
  const backRank = intent.side === "W" ? 1 : 8;
  assert(Number(to[1]) === backRank, "Must resurrect to back rank");
  assert(!state.board[to], "Square occupied");
}

function validateBishopBlockCheck(state, intent) {
  assert(isInCheck(state, intent.side), "Block Check only when in check");
  const { kingFrom, kingTo, followup } = intent.action.payload;
  const kingId = `${intent.side}_K`;
  const k = state.pieces[kingId];
  assert(k.status === "ACTIVE" && k.square === kingFrom, "Bad king move");
  const legalKing = generateMovesStandard(state, kingId).some((m) => m.to === kingTo);
  assert(legalKing, "Illegal king move");

  const p = state.pieces[followup.pieceId];
  assert(p && p.side === intent.side && p.status === "ACTIVE", "Bad followup piece");
  assert(p.square === followup.from, "Followup from mismatch");
  const legalFollow = generateMovesStandard(state, followup.pieceId).some((m) => m.to === followup.to);
  assert(legalFollow, "Illegal followup move");
}

function validateComboNN(state, intent) {
  const { mode } = intent.action.payload;
  assert(mode === "DOUBLE" || mode === "SPLIT", "Bad mode");
}

function validateComboMorph(state, intent) {
  const { otherKind, mode, pieceId, from } = intent.action.payload;
  assert(["KING", "ROOK", "QUEEN", "BISHOP"].includes(otherKind), "Bad other kind");
  assert(mode === "KNIGHT_AS_OTHER" || mode === "OTHER_AS_KNIGHT", "Bad mode");
  const p = state.pieces[pieceId];
  assert(p && p.side === intent.side && p.status === "ACTIVE", "Bad piece");
  assert(p.square === from, "From mismatch");
}

// ---------- Apply mutation ----------

function applyIntentMut(state, intent) {
  if (intent.kind === "SETUP") {
    applySetup(state, intent);
    state.meta.updatedAt = now();
    return;
  }

  const side = intent.side;

  // discard played cards
  const cardIds = intent.play.cardIds;
  for (const cid of cardIds) {
    const idx = state.cards[side].hand.indexOf(cid);
    if (idx >= 0) state.cards[side].hand.splice(idx, 1);
    state.cards[side].discard.push(cid);
  }

  const terminal = applyAction(state, intent);

  if (!terminal) {
    state.threat.inCheck.W = isInCheck(state, "W");
    state.threat.inCheck.B = isInCheck(state, "B");

    if (state.threat.inCheck[side]) {
      throw new Error("Illegal: ended turn in check");
    }
  }

  if (!terminal) {
    const turn = state.phase.turn;
    if (intent.action.type === "NOBLE_QUEEN_MOVE_EXTRA_TURN") {
      turn.extraTurnQueue += 1;
    }

    if (turn.extraTurnQueue > 0) {
      turn.extraTurnQueue -= 1;
      turn.step = "DRAW";
    } else {
      turn.side = otherSide(turn.side);
      turn.step = "DRAW";
    }
  }

  state.log.push({ t: now(), side, intent, summary: summarizeIntent(intent) });
}

function applySetup(state, intent) {
  const side = state.phase.setup.sideToPlace;
  const step = state.phase.setup.step;
  const a = intent.action;

  if (step === "PLACE_KING") {
    const to = a.payload.to;
    const kid = `${side}_K`;
    placePiece(state, kid, to);
    state.phase.setup.step = "PLACE_KNIGHTS";
    return;
  }

  if (step === "PLACE_KNIGHTS") {
    const { left, right } = a.payload;
    placePiece(state, `${side}_N1`, left);
    placePiece(state, `${side}_N2`, right);

    if (side === "W") {
      state.phase.setup.sideToPlace = "B";
      state.phase.setup.step = "PLACE_KING";
    } else {
      state.phase.stage = "TURN";
      state.phase.setup.step = "DONE";
      state.phase.turn.side = "W";
      state.phase.turn.step = "DRAW";
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

    case "NOBLE_BISHOP_RESURRECT": {
      const { pieceId, to } = a.payload;
      placePiece(state, pieceId, to);
      return false;
    }

    case "NOBLE_BISHOP_BLOCK_CHECK": {
      const { kingTo, followup } = a.payload;
      const terminal1 = movePiece(state, intent.side, `${intent.side}_K`, kingTo);
      if (terminal1) return true;
      return movePiece(state, intent.side, followup.pieceId, followup.to);
    }

    case "COMBO_NN": {
      const { mode, double, split } = a.payload;
      if (mode === "DOUBLE") {
        for (const mv of double.moves) {
          const terminal = movePiece(state, intent.side, double.pieceId, mv.to);
          if (terminal) return true;
        }
        return false;
      } else {
        const t1 = movePiece(state, intent.side, split.a.pieceId, split.a.to);
        if (t1) return true;
        return movePiece(state, intent.side, split.b.pieceId, split.b.to);
      }
    }

    case "COMBO_NX_MORPH": {
      const { pieceId, to } = a.payload;
      return movePiece(state, intent.side, pieceId, to);
    }

    default:
      throw new Error("Unknown action type");
  }
}

function placePiece(state, pieceId, to) {
  const p = state.pieces[pieceId];
  if (state.board[to]) throw new Error("Square occupied");
  if (p.square) delete state.board[p.square];
  p.status = "ACTIVE";
  p.square = to;
  state.board[to] = p.id;
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
      state.result.status = "WIN";
      state.result.winner = moverSide;
      state.result.reason = "KING_CAPTURED";

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

function summarizeIntent(intent) {
  if (intent.kind === "SETUP") return `${intent.side} ${intent.action.type}`;
  return `${intent.side} played ${intent.play.cardIds.join(",")} -> ${intent.action.type}`;
}

// ---------- Server-like draw + legality ----------

export function drawToEight(state, side) {
  const pile = state.cards[side];
  while (pile.hand.length < 8) {
    if (pile.deck.length === 0) {
      if (pile.discard.length === 0) break;
      pile.deck = pile.discard.splice(0);
      shuffleInPlace(pile.deck);
    }
    const cid = pile.deck.pop();
    if (!cid) break;
    pile.hand.push(cid);
  }
}

export function serverAdvanceDrawPhase(state) {
  const s = clone(state);

  if (s.phase.stage !== "TURN") return s;
  const turn = s.phase.turn;
  if (turn.step !== "DRAW") return s;

  const side = turn.side;
  drawToEight(s, side);

  s.threat.inCheck.W = isInCheck(s, "W");
  s.threat.inCheck.B = isInCheck(s, "B");

  turn.step = "PLAY";

  if (s.threat.inCheck[side]) {
    const legal = getLegalIntents(s, side);
    if (legal.length === 0) {
      s.result.status = "WIN";
      s.result.winner = otherSide(side);
      s.result.reason = "NO_LEGAL_PLAYS_IN_CHECK";
    }
  }

  s.meta.updatedAt = now();
  return s;
}

/**
 * Minimal legal intent generator so UI can highlight and AI can pick.
 * (This will be expanded as we implement all card abilities.)
 */
export function getLegalIntents(state, side) {
  if (state.result.status !== "ONGOING") return [];
  if (state.phase.stage !== "TURN") return [];
  if (state.phase.turn.side !== side) return [];
  if (state.phase.turn.step !== "PLAY") return [];

  const hand = state.cards[side].hand.slice();
  const intents = [];

  // Singles: pawn card moves pawns, knight card moves any piece (standard),
  // and any card can PLACE its corresponding piece type on back/second rank.
  for (const cid of hand) {
    const kind = state.cardInstances[cid]?.kind;
    if (!kind) continue;
  
    // PAWN: can place pawns (from reserve) AND move pawn pieces
    if (kind === "PAWN") {
      intents.push(...genPlaceForKind(state, side, cid, kind)); // pawn reserve -> 2nd rank
      intents.push(...genMoveIntents(state, side, cid, kind));  // pawn moves only
      continue;
    }
  
    // KNIGHT: move permission for any active piece
    if (kind === "KNIGHT") {
      intents.push(...genMoveIntents(state, side, cid, kind));
      continue;
    }
  
    // KING: noble only (king is always active; no placing king)
    if (kind === "KING") {
      intents.push(...genNobleIntents(state, side, cid, kind));
      continue;
    }
  
    // ROOK / BISHOP / QUEEN:
    // If the matching piece is inactive, this card places it.
    // If it is already active, this card does the noble ability.
    if (kind === "ROOK" || kind === "BISHOP" || kind === "QUEEN") {
      const hasInactive = hasInactivePieceForKind(state, side, kind);
      if (hasInactive) intents.push(...genPlaceForKind(state, side, cid, kind));
      else intents.push(...genNobleIntents(state, side, cid, kind));
      continue;
    }
  }

  // Filter by check rule:
  const inCheckNow = state.threat.inCheck?.[side] ?? isInCheck(state, side);
  const legal = [];

  for (const it of intents) {
    try {
      const next = applyIntentStrict(state, it);

      // allow king-capture regardless of still being in check
      if (next.result.status === "WIN" && next.result.reason === "KING_CAPTURED") {
        legal.push(it);
        continue;
      }

      // if started in check, must end out of check
      if (inCheckNow) {
        if (!isInCheck(next, side)) legal.push(it);
      } else {
        legal.push(it);
      }
    } catch {
      // invalid -> skip
    }
  }

  return legal;
}

function kindToPieceType(kind) {
  return { PAWN: "P", KNIGHT: "N", KING: "K", ROOK: "R", BISHOP: "B", QUEEN: "Q" }[kind] || null;
}

function hasInactivePieceForKind(state, side, kind) {
  const t = kindToPieceType(kind);
  if (!t) return false;
  // King is never placeable after setup in our current model
  if (t === "K") return false;
  return Object.values(state.pieces).some(p => p.side === side && p.type === t && p.status === "INACTIVE");
}

/**
 * Placement rules:
 * - PAWN -> 2nd rank (W=2, B=7), any empty file
 * - ROOK/BISHOP/QUEEN -> back rank (W=1, B=8), any empty file
 * - KING not placeable here (setup already placed it)
 * - KNIGHT not placeable via card (setup already places both)
 */
function genPlaceForKind(state, side, cid, kind) {
  const t = kindToPieceType(kind);
  if (!t) return [];
  if (t === "K" || t === "N") return []; // handled elsewhere

  const out = [];
  const inactive = Object.values(state.pieces)
    .filter(p => p.side === side && p.type === t && p.status === "INACTIVE");

  if (inactive.length === 0) return [];

  const backRank = side === "W" ? 1 : 8;
  const pawnRank = side === "W" ? 2 : 7;
  const targetRank = (t === "P") ? pawnRank : backRank;

  for (const p of inactive) {
    for (const f of FILES) {
      const to = `${f}${targetRank}`;
      if (state.board[to]) continue;

      out.push({
        kind: "TURN",
        side,
        play: { type: "SINGLE", cardIds: [cid] },
        action: { type: "PLACE", payload: { pieceId: p.id, to } }
      });
    }
  }
  return out;
}

// ---------- Intent generators ----------

function genMoveIntents(state, side, cid, kind) {
  const out = [];

  if (kind === "PAWN") {
    for (const p of Object.values(state.pieces)) {
      if (p.side !== side || p.type !== "P" || p.status !== "ACTIVE") continue;
      for (const m of generateMovesStandard(state, p.id)) {
        out.push({
          kind: "TURN",
          side,
          play: { type: "SINGLE", cardIds: [cid] },
          action: { type: "MOVE_STANDARD", payload: { pieceId: p.id, from: m.from, to: m.to } }
        });
      }
    }
  }

  if (kind === "KNIGHT") {
    for (const p of Object.values(state.pieces)) {
      if (p.side !== side || p.status !== "ACTIVE") continue;
      for (const m of generateMovesStandard(state, p.id)) {
        out.push({
          kind: "TURN",
          side,
          play: { type: "SINGLE", cardIds: [cid] },
          action: { type: "MOVE_STANDARD", payload: { pieceId: p.id, from: m.from, to: m.to } }
        });
      }
    }
  }

  return out;
}

function genNobleIntents(state, side, cid, kind) {
  const out = [];

  if (kind === "QUEEN") {
    const q = Object.values(state.pieces).find(p => p.side === side && p.type === "Q" && p.status === "ACTIVE");
    if (!q) return out;
    for (const m of generateMovesStandard(state, q.id)) {
      out.push({
        kind: "TURN",
        side,
        play: { type: "SINGLE", cardIds: [cid] },
        action: { type: "NOBLE_QUEEN_MOVE_EXTRA_TURN", payload: { pieceId: q.id, from: m.from, to: m.to } }
      });
    }
  }


  // (We’ll expand KING/ROOK/BISHOP nobles and combos after this is running cleanly.)
  return out;
}
