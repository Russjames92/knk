import { clone, now, assert, otherSide, fileOf, rankOf, inBounds, sq } from "./util.js";
import { FILES, generateMovesStandard, isInCheck } from "./moves.js";
import { shuffleInPlace } from "./state.js";

/**
 * Exports required by app.js:
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

/* ---------------- Validation ---------------- */

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

  // Combo rules:
  // - Pawn cards are never in combos
  // - Legal combo must be:
  //   (A) Knight + Knight
  //   (B) Knight + (King/Rook/Queen/Bishop)
  if (cardIds.length === 2) {
    const kinds = cardIds.map((cid) => state.cardInstances[cid].kind);
    assert(!kinds.includes("PAWN"), "Pawn cards cannot be in combos");

    const knightCount = kinds.filter((k) => k === "KNIGHT").length;
    assert(knightCount >= 1, "Combo must include at least one knight");

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

/* ---- Place Action ----
   - Use a single card representing a chess piece to place that piece IF it is available (inactive)
   - Pawns must be placed anywhere on 2nd rank (your side)
   - Any other piece must be placed anywhere on your back rank
*/
function validatePlace(state, intent) {
  const { pieceId, to } = intent.action.payload;
  const p = state.pieces[pieceId];
  assert(p && p.side === intent.side, "Bad piece");
  assert(p.status === "INACTIVE", "Piece not available (inactive required)");
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

/* ---- Noble Actions ---- */

function validateNobleKing(state, intent) {
  const { pieceId, from, to } = intent.action.payload;
  const p = state.pieces[pieceId];
  assert(p && p.side === intent.side, "Bad piece");
  assert(p.status === "ACTIVE", "Piece not active");
  assert(p.type !== "P", "Cannot target pawn");
  assert(p.square === from, "From mismatch");
  assert(!state.board[to], "King noble cannot capture");

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
  assert(a.square && b.square, "Both must be on board");
  assert(a.square !== b.square, "Cannot swap same square");
}

function validateResurrect(state, intent) {
  const { pieceId, to } = intent.action.payload;
  const p = state.pieces[pieceId];
  assert(p && p.side === intent.side, "Bad piece");
  assert(p.status === "CAPTURED", "Must be captured (not inactive)");
  assert(p.type !== "K", "Cannot resurrect king");
  assert(p.type !== "P", "Resurrect is for back-rank pieces");
  const backRank = intent.side === "W" ? 1 : 8;
  assert(Number(to[1]) === backRank, "Must resurrect to back rank");
  assert(!state.board[to], "Square occupied");
}

function validateBishopBlockCheck(state, intent) {
  assert(isInCheck(state, intent.side), "Block Check only when currently in check");

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

/* ---- Combos ---- */

function validateComboNN(state, intent) {
  const { mode } = intent.action.payload;
  assert(mode === "DOUBLE" || mode === "SPLIT", "Bad NN mode");
}

function validateComboMorph(state, intent) {
  const { otherKind, mode, pieceId, from, to } = intent.action.payload;
  assert(["KING", "ROOK", "QUEEN", "BISHOP"].includes(otherKind), "Bad other kind");
  assert(mode === "KNIGHT_AS_OTHER" || mode === "OTHER_AS_KNIGHT", "Bad morph mode");

  const p = state.pieces[pieceId];
  assert(p && p.side === intent.side && p.status === "ACTIVE", "Bad piece");
  assert(p.square === from, "From mismatch");

  if (mode === "OTHER_AS_KNIGHT") {
    // represented back-rank piece moves like a knight
    const legal = genKnightDests(state, from, intent.side).includes(to);
    assert(legal, "Illegal knight-morph move");
  } else {
    // knight moves like KING/ROOK/BISHOP/QUEEN
    const legal = genAsOtherDests(state, from, intent.side, otherKind).includes(to);
    assert(legal, "Illegal piece-morph move");
  }
}

/* ---------------- Apply mutation ---------------- */

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

    // Standard rule: you cannot end your play leaving your king in check
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
        // move one knight twice
        for (const mv of double.moves) {
          const terminal = movePiece(state, intent.side, double.pieceId, mv.to);
          if (terminal) return true;
        }
        return false;
      } else {
        // move both knights once each
        const t1 = movePiece(state, intent.side, split.a.pieceId, split.a.to);
        if (t1) return true;
        return movePiece(state, intent.side, split.b.pieceId, split.b.to);
      }
    }

    case "COMBO_NX_MORPH": {
      // validation already enforced movement pattern; we just execute the move
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
  const kinds = intent.play.cardIds.map((id) => intent._kinds?.[id] ?? id).join(",");
  return `${intent.side} played ${kinds} -> ${intent.action.type}`;
}

/* ---------------- Draw phase + end check logic ---------------- */

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

  // If you're in check and have no legal intents that resolve it, you lose.
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

/* ---------------- Legal Intent Generator ---------------- */

export function getLegalIntents(state, side) {
  if (state.result.status !== "ONGOING") return [];
  if (state.phase.stage !== "TURN") return [];
  if (state.phase.turn.side !== side) return [];
  if (state.phase.turn.step !== "PLAY") return [];

  const hand = state.cards[side].hand.slice();
  const intents = [];

  // Singles
  for (const cid of hand) {
    const kind = state.cardInstances[cid]?.kind;
    if (!kind) continue;

    // Place action (any piece card) IF piece(s) of that type are inactive and squares allow it
    intents.push(...genPlaceIntents(state, side, cid, kind));

    // Move action (only pawn/knight)
    intents.push(...genMoveActionIntents(state, side, cid, kind));

    // Noble action (only king/rook/queen/bishop)
    intents.push(...genNobleIntents(state, side, cid, kind));
  }

  // Combos
  intents.push(...genComboIntents(state, side));

  // Enforce check rule:
  // If you start in check, your action must end with your king not in check
  // unless you capture enemy king (terminal).
  const inCheckNow = state.threat.inCheck?.[side] ?? isInCheck(state, side);
  const legal = [];

  for (const it of intents) {
    try {
      const next = applyIntentStrict(state, it);

      // allow king-capture regardless of still-being-in-check
      if (next.result.status === "WIN" && next.result.reason === "KING_CAPTURED") {
        legal.push(it);
        continue;
      }

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

/* ---------------- Intent builders ---------------- */

function genPlaceIntents(state, side, cid, kind) {
  const map = { PAWN: "P", KNIGHT: "N", KING: "K", ROOK: "R", QUEEN: "Q", BISHOP: "B" };
  const pType = map[kind];
  if (!pType) return [];

  // piece must be INACTIVE to be placed (available)
  const inactive = Object.values(state.pieces).filter(
    (p) => p.side === side && p.type === pType && p.status === "INACTIVE"
  );
  if (inactive.length === 0) return [];

  const backRank = side === "W" ? 1 : 8;
  const secondRank = side === "W" ? 2 : 7;
  const targetRank = pType === "P" ? secondRank : backRank;

  const out = [];
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

function genMoveActionIntents(state, side, cid, kind) {
  const out = [];

  // Pawn card move action: move ONLY a pawn with standard chess pawn rules
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

  // Knight card move action: move ANY piece with standard chess rules for that piece
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

/* Noble actions triggered by KING / ROOK / QUEEN / BISHOP cards */

function genNobleIntents(state, side, cid, kind) {
  const out = [];

  // King card noble: move ANY back-rank piece (not pawn) to adjacent OPEN square, no capture.
  if (kind === "KING") {
    for (const p of Object.values(state.pieces)) {
      if (p.side !== side || p.status !== "ACTIVE") continue;
      if (p.type === "P") continue;
      const from = p.square;
      for (const to of genAdjacentOpenSquares(state, from)) {
        out.push({
          kind: "TURN",
          side,
          play: { type: "SINGLE", cardIds: [cid] },
          action: { type: "NOBLE_KING_ADJ_NO_CAPTURE", payload: { pieceId: p.id, from, to } }
        });
      }
    }
  }

  // Rook card noble: swap ANY two back-rank pieces (not pawns)
  if (kind === "ROOK") {
    const pieces = Object.values(state.pieces).filter(
      (p) => p.side === side && p.status === "ACTIVE" && p.type !== "P" && p.square
    );
    for (let i = 0; i < pieces.length; i++) {
      for (let j = i + 1; j < pieces.length; j++) {
        out.push({
          kind: "TURN",
          side,
          play: { type: "SINGLE", cardIds: [cid] },
          action: { type: "NOBLE_ROOK_SWAP", payload: { pieceA: pieces[i].id, pieceB: pieces[j].id } }
        });
      }
    }
  }

  // Queen card noble: move ANY piece (including pawns) with standard rules, THEN extra turn
  if (kind === "QUEEN") {
    for (const p of Object.values(state.pieces)) {
      if (p.side !== side || p.status !== "ACTIVE") continue;
      for (const m of generateMovesStandard(state, p.id)) {
        out.push({
          kind: "TURN",
          side,
          play: { type: "SINGLE", cardIds: [cid] },
          action: { type: "NOBLE_QUEEN_MOVE_EXTRA_TURN", payload: { pieceId: p.id, from: m.from, to: m.to } }
        });
      }
    }
  }

  // Bishop card noble: (A) Resurrect captured back-rank (except king) to back rank
  // or (B) Block Check: if in check, move king out of check, THEN move any piece standard
  if (kind === "BISHOP") {
    // Resurrect
    const capturedBack = Object.values(state.pieces).filter(
      (p) => p.side === side && p.status === "CAPTURED" && p.type !== "K" && p.type !== "P"
    );
    const backRank = side === "W" ? 1 : 8;
    for (const p of capturedBack) {
      for (const f of FILES) {
        const to = `${f}${backRank}`;
        if (state.board[to]) continue;
        out.push({
          kind: "TURN",
          side,
          play: { type: "SINGLE", cardIds: [cid] },
          action: { type: "NOBLE_BISHOP_RESURRECT", payload: { pieceId: p.id, to } }
        });
      }
    }

    // Block Check
    if (isInCheck(state, side)) {
      const kingId = `${side}_K`;
      const king = state.pieces[kingId];
      if (king?.status === "ACTIVE" && king.square) {
        const kingFrom = king.square;
        const kingMoves = generateMovesStandard(state, kingId);

        // after moving king, we can move ANY piece with standard rules
        for (const km of kingMoves) {
          // simulate king move first to know followup move legality space
          const afterKing = applyIntentStrict(state, {
            kind: "TURN",
            side,
            play: { type: "SINGLE", cardIds: [cid] },
            action: { type: "MOVE_STANDARD", payload: { pieceId: kingId, from: kingFrom, to: km.to } }
          });

          // king must be out of check immediately after king move
          if (isInCheck(afterKing, side)) continue;

          for (const p of Object.values(afterKing.pieces)) {
            if (p.side !== side || p.status !== "ACTIVE") continue;
            for (const m of generateMovesStandard(afterKing, p.id)) {
              out.push({
                kind: "TURN",
                side,
                play: { type: "SINGLE", cardIds: [cid] },
                action: {
                  type: "NOBLE_BISHOP_BLOCK_CHECK",
                  payload: {
                    kingFrom,
                    kingTo: km.to,
                    followup: { pieceId: p.id, from: m.from, to: m.to }
                  }
                }
              });
            }
          }
        }
      }
    }
  }

  return out;
}

/* ---------------- Combos ---------------- */

function genComboIntents(state, side) {
  const out = [];
  const hand = state.cards[side].hand.slice();

  // Gather card IDs by kind
  const byKind = new Map();
  for (const cid of hand) {
    const k = state.cardInstances[cid]?.kind;
    if (!k) continue;
    if (!byKind.has(k)) byKind.set(k, []);
    byKind.get(k).push(cid);
  }

  const knightCards = byKind.get("KNIGHT") || [];

  // Knight-Knight combo (two knight cards)
  if (knightCards.length >= 2) {
    for (let i = 0; i < knightCards.length; i++) {
      for (let j = i + 1; j < knightCards.length; j++) {
        const c1 = knightCards[i], c2 = knightCards[j];
        out.push(...genComboNN(state, side, [c1, c2]));
      }
    }
  }

  // Knight + (King/Rook/Queen/Bishop)
  for (const otherKind of ["KING", "ROOK", "QUEEN", "BISHOP"]) {
    const others = byKind.get(otherKind) || [];
    for (const ncid of knightCards) {
      for (const ocid of others) {
        out.push(...genComboNX(state, side, [ncid, ocid], otherKind));
      }
    }
  }

  return out;
}

function genComboNN(state, side, cardIds) {
  const out = [];

  const knights = Object.values(state.pieces).filter(
    (p) => p.side === side && p.status === "ACTIVE" && p.type === "N" && p.square
  );
  if (knights.length === 0) return out;

  // Mode A: move ONE knight twice (sequence)
  for (const n of knights) {
    const firstMoves = generateMovesStandard(state, n.id);
    for (const m1 of firstMoves) {
      const after1 = applyIntentStrict(state, {
        kind: "TURN",
        side,
        play: { type: "COMBO", cardIds },
        action: { type: "MOVE_STANDARD", payload: { pieceId: n.id, from: m1.from, to: m1.to } }
      });

      const secondMoves = generateMovesStandard(after1, n.id);
      for (const m2 of secondMoves) {
        out.push({
          kind: "TURN",
          side,
          play: { type: "COMBO", cardIds },
          action: {
            type: "COMBO_NN",
            payload: {
              mode: "DOUBLE",
              double: {
                pieceId: n.id,
                moves: [{ to: m1.to }, { to: m2.to }]
              }
            }
          }
        });
      }
    }
  }

  // Mode B: move BOTH knights once each
  if (knights.length >= 2) {
    // Use distinct knight ids
    for (let i = 0; i < knights.length; i++) {
      for (let j = 0; j < knights.length; j++) {
        if (i === j) continue;
        const a = knights[i], b = knights[j];

        const movesA = generateMovesStandard(state, a.id);
        const movesB = generateMovesStandard(state, b.id);

        for (const ma of movesA) {
          for (const mb of movesB) {
            if (ma.to === mb.to) continue; // cannot end on same square
            out.push({
              kind: "TURN",
              side,
              play: { type: "COMBO", cardIds },
              action: {
                type: "COMBO_NN",
                payload: {
                  mode: "SPLIT",
                  split: {
                    a: { pieceId: a.id, from: ma.from, to: ma.to },
                    b: { pieceId: b.id, from: mb.from, to: mb.to }
                  }
                }
              }
            });
          }
        }
      }
    }
  }

  return out;
}

function genComboNX(state, side, cardIds, otherKind) {
  const out = [];

  // Option 1: move ONE of your knights like the other piece
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
            mode: "KNIGHT_AS_OTHER",
            pieceId: n.id,
            from,
            to
          }
        }
      });
    }
  }

  // Option 2: move the represented back-rank piece like a knight
  // (King/Rook/Queen/Bishop piece moves in L shape for one turn)
  const typeMap = { KING: "K", ROOK: "R", QUEEN: "Q", BISHOP: "B" };
  const targetType = typeMap[otherKind];

  const targets = Object.values(state.pieces).filter(
    (p) => p.side === side && p.status === "ACTIVE" && p.type === targetType && p.square
  );

  for (const p of targets) {
    const from = p.square;
    for (const to of genKnightDests(state, from, side)) {
      out.push({
        kind: "TURN",
        side,
        play: { type: "COMBO", cardIds },
        action: {
          type: "COMBO_NX_MORPH",
          payload: {
            otherKind,
            mode: "OTHER_AS_KNIGHT",
            pieceId: p.id,
            from,
            to
          }
        }
      });
    }
  }

  return out;
}

/* ---------------- Movement helpers used for morph validation/generation ---------------- */

function genAdjacentOpenSquares(state, from) {
  const out = [];
  const f0 = from.charCodeAt(0);
  const r0 = Number(from[1]);
  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      if (df === 0 && dr === 0) continue;
      const nf = String.fromCharCode(f0 + df);
      const nr = r0 + dr;
      if (!inBounds(nf, nr)) continue;
      const to = sq(nf, nr);
      if (!state.board[to]) out.push(to);
    }
  }
  return out;
}

function genKnightDests(state, from, side) {
  const out = [];
  const deltas = [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]];
  const fIdx = FILES.indexOf(fileOf(from));
  const r = rankOf(from);

  for (const [df, dr] of deltas) {
    const nf = FILES[fIdx + df];
    const nr = r + dr;
    if (!nf || !inBounds(nf, nr)) continue;
    const to = sq(nf, nr);
    const occId = state.board[to];
    if (!occId) { out.push(to); continue; }
    const occ = state.pieces[occId];
    if (occ.side !== side) out.push(to);
  }
  return out;
}

function genAsOtherDests(state, from, side, otherKind) {
  if (otherKind === "KING") {
    // king-like: adjacent (capture allowed)
    const out = [];
    const f0 = from.charCodeAt(0);
    const r0 = Number(from[1]);
    for (let df = -1; df <= 1; df++) {
      for (let dr = -1; dr <= 1; dr++) {
        if (df === 0 && dr === 0) continue;
        const nf = String.fromCharCode(f0 + df);
        const nr = r0 + dr;
        if (!inBounds(nf, nr)) continue;
        const to = sq(nf, nr);
        const occId = state.board[to];
        if (!occId) { out.push(to); continue; }
        const occ = state.pieces[occId];
        if (occ.side !== side) out.push(to);
      }
    }
    return out;
  }

  const rays = [];
  if (otherKind === "ROOK" || otherKind === "QUEEN") rays.push([1,0],[-1,0],[0,1],[0,-1]);
  if (otherKind === "BISHOP" || otherKind === "QUEEN") rays.push([1,1],[1,-1],[-1,1],[-1,-1]);

  const out = [];
  for (const [df, dr] of rays) {
    let f = FILES.indexOf(fileOf(from));
    let r = rankOf(from);
    while (true) {
      f += df; r += dr;
      const nf = FILES[f];
      if (!nf || !inBounds(nf, r)) break;
      const to = sq(nf, r);
      const occId = state.board[to];
      if (!occId) { out.push(to); continue; }
      const occ = state.pieces[occId];
      if (occ.side !== side) out.push(to);
      break;
    }
  }
  return out;
}
