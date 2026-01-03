import { clone, now, assert, otherSide, fileOf, rankOf, inBounds, sq } from "./util.js";
import { FILES, generateMovesStandard, isInCheck } from "./moves.js";
import { shuffleInPlace } from "./state.js";

/**
 * Browser exports expected by app.js:
 * - getLegalIntents(state, side)
 * - applyIntent(state, intent)
 * - evaluateGame(state)
 * - serverAdvanceDrawPhase(state)
 */

export function applyIntent(state, intent) {
  return applyIntentStrict(state, intent);
}

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

export function serverAdvanceDrawPhase(state) {
  const s = clone(state);
  const turn = s.phase.turn;
  const side = turn.side;

  if (turn.step === "PLAY") return s;

  if (turn.step === "DRAW") {
    while ((s.hands[side] || []).length < 8) {
      const next = s.decks[side].shift();
      if (!next) break;
      s.hands[side].push(next);
    }
    turn.step = "PLAY";

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

  if (state.phase.stage === "TURN") {
    assert(state.phase.turn.side === side, "Not your turn");
    assert(state.phase.turn.step === "PLAY", "Not in PLAY step");
  }

  if (state.phase.stage === "SETUP") {
    validateSetupIntent(state, intent);
    return;
  }

  if (intent.play?.cardIds?.length) {
    for (const cid of intent.play.cardIds) {
      assert((state.hands[side] || []).includes(cid), "Card not in hand");
    }
  }

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

  if (a.type.startsWith("NOBLE_") || a.type.startsWith("COMBO_")) {
    assert(a.payload != null, "Missing action.payload");
  }
}

function validateSetupIntent(state, intent) {
  const { step, sideToPlace } = state.phase.setup;

  assert(intent.kind === "SETUP", "Setup intent required");
  assert(intent.side === sideToPlace, "Wrong side to place");

  const { action } = intent;

  // Setup is ONLY choosing the king square
  assert(step === "PLACE_KING", "Setup already complete");
  assert(action.type === "SETUP_PLACE_KING", "Expected king placement");

  const { to } = action.payload;
  const backRank = intent.side === "W" ? 1 : 8;

  assert(Number(to[1]) === backRank, "King must be on back rank");
  assert(
    to !== (intent.side === "W" ? "a1" : "a8") && to !== (intent.side === "W" ? "h1" : "h8"),
    "King cannot be in a corner"
  );
  assert(!state.board[to], "Square occupied");

  // Knights must be adjacent squares and empty
  const f = to[0];
  const left = String.fromCharCode(f.charCodeAt(0) - 1) + backRank;
  const right = String.fromCharCode(f.charCodeAt(0) + 1) + backRank;

  assert(!state.board[left] && !state.board[right], "Adjacent knight squares must be empty");
}

function applyIntentMut(state, intent) {
  const side = intent.side;

  if (intent.play?.cardIds?.length) {
    for (const cid of intent.play.cardIds) {
      const idx = state.hands[side].indexOf(cid);
      if (idx >= 0) state.hands[side].splice(idx, 1);
      state.discard[side].push(cid);
    }
  }

  if (state.phase.stage === "SETUP") {
    applySetupMut(state, intent);
    return;
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
  } else {
    state.phase.stage = "ENDED";
    state.result = { status: "ENDED", winner: side, reason: "King captured" };
  }
}

function applySetupMut(state, intent) {
  const side = intent.side;
  const setup = state.phase.setup;

  // Only step: PLACE_KING
  const kingId = findPieceInHand(state, side, "K");
  const to = intent.action.payload.to;

  placePiece(state, kingId, to);

  const backRank = side === "W" ? 1 : 8;
  const f = to[0];

  const leftSq = `${String.fromCharCode(f.charCodeAt(0) - 1)}${backRank}`;
  const rightSq = `${String.fromCharCode(f.charCodeAt(0) + 1)}${backRank}`;

  const knights = Object.values(state.pieces).filter(
    (p) => p.side === side && p.type === "N" && p.status === "IN_HAND"
  );
  assert(knights.length >= 2, "Not enough knights in hand");
  assert(!state.board[leftSq] && !state.board[rightSq], "Knight squares occupied");

  // Place both knights adjacent automatically
  placePiece(state, knights[0].id, leftSq);
  placePiece(state, knights[1].id, rightSq);

  // Next side, or finish setup
  if (setup.sideToPlace === "W") {
    setup.sideToPlace = "B";
    setup.step = "PLACE_KING";
  } else {
    setup.step = "DONE";
    state.phase.stage = "TURN";
    state.phase.turn = { side: "W", step: "DRAW", extraTurnQueue: 0 };

    shuffleInPlace(state.decks.W);
    shuffleInPlace(state.decks.B);

    Object.assign(state, serverAdvanceDrawPhase(state));
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
      const { move } = a.payload;
      return movePiece(state, intent.side, move.pieceId, move.to);
    }

    default:
      throw new Error("Unknown action type: " + a.type);
  }
}

/* ------------------ Legal intents generator ------------------ */

export function getLegalIntents(state, side) {
  if (state.phase.stage === "ENDED") return [];

  if (state.phase.stage === "SETUP") {
    return getSetupIntents(state, side);
  }

  if (state.phase.stage === "TURN") {
    if (state.phase.turn.side !== side) return [];
    if (state.phase.turn.step !== "PLAY") return [];
  }

  const intents = [];
  const hand = state.hands[side] || [];

  for (const cid of hand) intents.push(...genSingle(state, side, cid));

  for (let i = 0; i < hand.length; i++) {
    for (let j = i + 1; j < hand.length; j++) {
      intents.push(...genCombo(state, side, hand[i], hand[j]));
    }
  }

  if (state.threat?.inCheck?.[side]) {
    return intents.filter((it) => resolvesCheckOrCapturesKing(state, it));
  }

  return intents;
}

function resolvesCheckOrCapturesKing(state, intent) {
  try {
    const after = applyIntentStrict(state, intent);
    if (after.phase.stage === "ENDED") return true;
    return !after.threat.inCheck[intent.side];
  } catch {
    return false;
  }
}

function getSetupIntents(state, side) {
  const s = state.phase.setup;
  if (s.sideToPlace !== side) return [];
  if (s.step !== "PLACE_KING") return [];

  const out = [];
  const backRank = side === "W" ? 1 : 8;

  for (const f of FILES) {
    const to = `${f}${backRank}`;

    // not corners
    if (to === (side === "W" ? "a1" : "a8")) continue;
    if (to === (side === "W" ? "h1" : "h8")) continue;

    // ensure adjacent knight squares exist and are empty
    const leftFile = String.fromCharCode(f.charCodeAt(0) - 1);
    const rightFile = String.fromCharCode(f.charCodeAt(0) + 1);

    if (!inBounds(leftFile, backRank) || !inBounds(rightFile, backRank)) continue;

    const left = `${leftFile}${backRank}`;
    const right = `${rightFile}${backRank}`;

    if (state.board[to] || state.board[left] || state.board[right]) continue;

    out.push({ kind: "SETUP", side, action: { type: "SETUP_PLACE_KING", payload: { to } } });
  }

  return out;
}

/* ------------------ Single / Combo generators ------------------ */

function cardKind(state, cardId) {
  return state.cards?.[cardId]?.kind || state.deck?.[cardId]?.kind || state.cardMeta?.[cardId]?.kind;
}

function genSingle(state, side, cardId) {
  const kind = cardKind(state, cardId);

  if (kind === "KNIGHT") {
    return genMoveStandardForAny(state, side, { type: "SINGLE", cardIds: [cardId] });
  }

  if (kind === "PAWN") {
    const out = [];
    // ✅ allow placing a pawn if one is in hand
    out.push(...genPlace(state, side, cardId));
    // ✅ also allow moving existing pawns (if any are already active)
    out.push(...genPawnStandard(state, side, { type: "SINGLE", cardIds: [cardId] }));
    return out;
  }

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

  if (ka === "KNIGHT" && kb === "KNIGHT") return genComboNN(state, side, cardIds);

  if (ka === "KNIGHT" && kb !== "KNIGHT") return genComboNX(state, side, cardIds, kb);
  if (kb === "KNIGHT" && ka !== "KNIGHT") return genComboNX(state, side, cardIds, ka);

  return [];
}

/* ------------------ PLACE generation ------------------ */

function genPlace(state, side, cardId) {
  const kind = cardKind(state, cardId);
  const piece = Object.values(state.pieces).find(
    (p) => p.side === side && p.type === kindToPieceType(kind) && p.status === "IN_HAND"
  );
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

/* ------------------ Standard moves ------------------ */

function genMoveStandardForAny(state, side, play) {
  const out = [];
  const pieces = Object.values(state.pieces).filter((p) => p.side === side && p.status === "ACTIVE" && p.square);
  for (const p of pieces) {
    const moves = generateMovesStandard(state, p.id); // [{from,to}]
    for (const m of moves) {
      out.push({
        kind: "TURN",
        side,
        play,
        action: { type: "MOVE_STANDARD", payload: { pieceId: p.id, to: m.to } },
      });
    }
  }
  return out;
}

function genPawnStandard(state, side, play) {
  const out = [];
  const pawns = Object.values(state.pieces).filter((p) => p.side === side && p.status === "ACTIVE" && p.type === "P" && p.square);
  for (const p of pawns) {
    const moves = generateMovesStandard(state, p.id); // [{from,to}]
    for (const m of moves) {
      out.push({
        kind: "TURN",
        side,
        play,
        action: { type: "MOVE_STANDARD", payload: { pieceId: p.id, to: m.to } },
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
  const deltas = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
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
    const moves = generateMovesStandard(state, q.id); // [{from,to}]
    for (const m of moves) {
      out.push({
        kind: "TURN",
        side,
        play: { type: "SINGLE", cardIds: [cardId] },
        action: { type: "NOBLE_QUEEN_MOVE_EXTRA_TURN", payload: { pieceId: q.id, to: m.to } },
      });
    }
  }
  return out;
}

function genNobleBishop(state, side, cardId) {
  return [];
}

/* ------------------ Combos ------------------ */

function genComboNN(state, side, cardIds) {
  const out = [];
  const knights = Object.values(state.pieces).filter((p) => p.side === side && p.status === "ACTIVE" && p.type === "N" && p.square);
  if (!knights.length) return out;

  // DOUBLE
  for (const n of knights) {
    const firsts = generateMovesStandard(state, n.id); // [{from,to}]
    for (const m1 of firsts) {
      const to1 = m1.to;

      let tmp;
        try {
          tmp = applyIntentStrict(state, {
            kind: "TURN",
            side,
            play: { type: "COMBO", cardIds },
            action: { type: "MOVE_STANDARD", payload: { pieceId: n.id, to: to1 } },
          });
        } catch {
          // This first step is illegal (often because it leaves mover in check). Skip it.
          continue;
        }

      if (tmp.phase.stage === "ENDED") {
        out.push({
          kind: "TURN",
          side,
          play: { type: "COMBO", cardIds },
          action: { type: "COMBO_NN", payload: { mode: "DOUBLE", double: { pieceId: n.id, moves: [{ to: to1 }, { to: to1 }] } } },
        });
        continue;
      }

      const seconds = generateMovesStandard(tmp, n.id); // [{from,to}]
      for (const m2 of seconds) {
        out.push({
          kind: "TURN",
          side,
          play: { type: "COMBO", cardIds },
          action: { type: "COMBO_NN", payload: { mode: "DOUBLE", double: { pieceId: n.id, moves: [{ to: to1 }, { to: m2.to }] } } },
        });
      }
    }
  }

  // SPLIT
  for (let i = 0; i < knights.length; i++) {
    for (let j = i + 1; j < knights.length; j++) {
      const A = knights[i], B = knights[j];
      const movesA = generateMovesStandard(state, A.id);
      const movesB = generateMovesStandard(state, B.id);

      for (const mA of movesA) {
        for (const mB of movesB) {
          out.push({
            kind: "TURN",
            side,
            play: { type: "COMBO", cardIds },
            action: {
              type: "COMBO_NN",
              payload: { mode: "SPLIT", split: { a: { pieceId: A.id, to: mA.to }, b: { pieceId: B.id, to: mB.to } } },
            },
          });
        }
      }
    }
  }

  return out;
}

function genComboNX(state, side, cardIds, otherKind) {
  const out = [];
  const knights = Object.values(state.pieces).filter((p) => p.side === side && p.status === "ACTIVE" && p.type === "N" && p.square);

  for (const n of knights) {
    const from = n.square;
    for (const to of genAsOtherDests(state, from, side, otherKind)) {
      out.push({
        kind: "TURN",
        side,
        play: { type: "COMBO", cardIds },
        action: { type: "COMBO_NX_MORPH", payload: { otherKind, move: { pieceId: n.id, to } } },
      });
    }
  }

  return out;
}

function genAsOtherDests(state, from, side, otherKind) {
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
      f += df; r += dr;
      const nf = String.fromCharCode(f);
      if (!inBounds(nf, r)) break;
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
  for (let r = 1; r <= 8; r++) for (const f of FILES) out.push(`${f}${r}`);
  return out;
}
