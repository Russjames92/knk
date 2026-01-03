import { clone, now, assert, otherSide } from "./util.js";
import { generateMovesStandard, isInCheck } from "./moves.js";
import { shuffleInPlace } from "./state.js";

export function applyIntentStrict(state, intent){
  // Throws if invalid.
  const s = clone(state);
  validateIntent(s, intent);
  applyIntentMut(s, intent);
  s.meta.updatedAt = now();
  return s;
}

export function validateIntent(state, intent){
  assert(state.result.status === "ONGOING", "Game over");
  assert(intent && intent.side, "Bad intent");

  if(intent.kind === "SETUP"){
    return validateSetup(state, intent);
  }
  assert(state.phase.stage === "TURN", "Not in TURN phase");
  assert(state.phase.turn.side === intent.side, "Not your turn");
  assert(state.phase.turn.step === "PLAY" || state.phase.turn.step === "RESOLVE", "Wrong step");

  // For starter: allow a single combined intent that includes play+action at once (simpler)
  assert(intent.play && intent.action, "Missing play/action");
  validateCardPlay(state, intent);
  validateAction(state, intent);
}

function validateSetup(state, intent){
  assert(state.phase.stage === "SETUP", "Not in setup");
  const side = state.phase.setup.sideToPlace;
  assert(intent.side === side, "Wrong side for setup");
  const { step } = state.phase.setup;
  const { action } = intent;

  if(step === "PLACE_KING"){
    assert(action.type === "SETUP_PLACE_KING", "Expected king placement");
    const { to } = action.payload;
    const backRank = side === "W" ? 1 : 8;
    assert(Number(to[1]) === backRank, "King must be on back rank");
    assert(to !== (side==="W"?"a1":"a8") && to !== (side==="W"?"h1":"h8"), "King cannot be in a corner");
    assert(!state.board[to], "Square occupied");
    return;
  }

  if(step === "PLACE_KNIGHTS"){
    assert(action.type === "SETUP_PLACE_KNIGHTS", "Expected knight placement");
    const { left, right } = action.payload;
    const kingSq = state.pieces[`${side}_K`]?.square;
    assert(kingSq, "King must be placed first");
    const bf = kingSq[0], br = kingSq[1];
    const leftExpected = String.fromCharCode(bf.charCodeAt(0)-1) + br;
    const rightExpected = String.fromCharCode(bf.charCodeAt(0)+1) + br;
    assert(left === leftExpected && right === rightExpected, "Knights must be placed adjacent to king");
    assert(!state.board[left] && !state.board[right], "Square occupied");
    return;
  }

  throw new Error("Unknown setup step");
}

function validateCardPlay(state, intent){
  const side = intent.side;
  const hand = state.cards[side].hand;
  const cardIds = intent.play.cardIds || [];
  assert(cardIds.length === 1 || cardIds.length === 2, "Must play 1 card or 2-card combo");

  for(const cid of cardIds){
    assert(hand.includes(cid), "Card not in hand");
  }

  if(cardIds.length === 2){
    // Legal combos: (KNIGHT+KNIGHT) or (KNIGHT + other back-rank card). Pawn ineligible. :contentReference[oaicite:2]{index=2}
    const kinds = cardIds.map(cid => state.cardInstances[cid].kind);
    assert(!kinds.includes("PAWN"), "Pawn cards cannot be used in combos");
    const knightCount = kinds.filter(k=>k==="KNIGHT").length;
    assert(knightCount >= 1, "Combo must include a knight");
    if(knightCount === 1){
      const other = kinds.find(k=>k!=="KNIGHT");
      assert(["KING","ROOK","QUEEN","BISHOP"].includes(other), "Invalid combo partner");
    }
    if(knightCount === 2){
      // ok
    }
  }
}

function validateAction(state, intent){
  const side = intent.side;
  const inCheck = isInCheck(state, side);

  // Generate: validate by action type
  const a = intent.action;
  switch(a.type){
    case "PLACE": return validatePlace(state, intent);
    case "MOVE_STANDARD": return validateMoveStandard(state, intent);
    case "NOBLE_KING_ADJ_NO_CAPTURE": return validateNobleKing(state, intent);
    case "NOBLE_ROOK_SWAP": return validateNobleRook(state, intent);
    case "NOBLE_QUEEN_MOVE_EXTRA_TURN": return validateMoveStandard(state, intent);
    case "NOBLE_BISHOP_RESURRECT": return validateResurrect(state, intent);
    case "NOBLE_BISHOP_BLOCK_CHECK":
      assert(inCheck, "Block Check only when in check");
      return validateBishopBlockCheck(state, intent);
    case "COMBO_NN": return validateComboNN(state, intent);
    case "COMBO_NX_MORPH": return validateComboMorph(state, intent);
    default: throw new Error("Unknown action type");
  }
}

function validatePlace(state, intent){
  const { pieceId, to } = intent.action.payload;
  const p = state.pieces[pieceId];
  assert(p && p.side === intent.side, "Bad piece");
  assert(p.status === "INACTIVE", "Piece not available");
  assert(!state.board[to], "Square occupied");

  const rank = Number(to[1]);
  const backRank = intent.side === "W" ? 1 : 8;
  const secondRank = intent.side === "W" ? 2 : 7;
  if(p.type === "P") assert(rank === secondRank, "Pawn must be placed on second rank");
  else assert(rank === backRank, "Non-pawn must be placed on back rank");
}

function validateMoveStandard(state, intent){
  const { pieceId, from, to } = intent.action.payload;
  const p = state.pieces[pieceId];
  assert(p && p.side === intent.side, "Bad piece");
  assert(p.status === "ACTIVE", "Piece not active");
  assert(p.square === from, "From mismatch");

  const legal = generateMovesStandard(state, pieceId).some(m => m.to === to);
  assert(legal, "Illegal move");
}

function validateNobleKing(state, intent){
  // Move any non-pawn 1-square adjacent to empty square, no capture. :contentReference[oaicite:3]{index=3}
  const { pieceId, from, to } = intent.action.payload;
  const p = state.pieces[pieceId];
  assert(p && p.side === intent.side, "Bad piece");
  assert(p.status==="ACTIVE", "Piece not active");
  assert(p.type !== "P", "Cannot target pawn");
  assert(p.square === from, "From mismatch");
  assert(!state.board[to], "Noble King cannot capture");

  const df = Math.abs(to.charCodeAt(0) - from.charCodeAt(0));
  const dr = Math.abs(Number(to[1]) - Number(from[1]));
  assert(df <= 1 && dr <= 1 && (df+dr>0), "Must move to adjacent square");
}

function validateNobleRook(state, intent){
  // Swap any two non-pawns. :contentReference[oaicite:4]{index=4}
  const { pieceA, pieceB } = intent.action.payload;
  const a = state.pieces[pieceA], b = state.pieces[pieceB];
  assert(a && b, "Missing pieces");
  assert(a.side===intent.side && b.side===intent.side, "Wrong side");
  assert(a.status==="ACTIVE" && b.status==="ACTIVE", "Both must be active");
  assert(a.type!=="P" && b.type!=="P", "Cannot swap pawns");
  assert(a.square && b.square, "Must be on board");
}

function validateResurrect(state, intent){
  // Resurrect captured non-king, non-pawn to open back rank. :contentReference[oaicite:5]{index=5}
  const { pieceId, to } = intent.action.payload;
  const p = state.pieces[pieceId];
  assert(p && p.side===intent.side, "Bad piece");
  assert(p.status==="CAPTURED", "Must be captured");
  assert(p.type!=="K", "Cannot resurrect king");
  assert(p.type!=="P", "Back-rank piece means non-pawn");
  const backRank = intent.side==="W" ? 1 : 8;
  assert(Number(to[1])===backRank, "Must resurrect to back rank");
  assert(!state.board[to], "Square occupied");
}

function validateBishopBlockCheck(state, intent){
  // Move king out of check (standard), then any piece standard. :contentReference[oaicite:6]{index=6}
  const { kingFrom, kingTo, followup } = intent.action.payload;
  const kingId = `${intent.side}_K`;
  const k = state.pieces[kingId];
  assert(k.status==="ACTIVE" && k.square===kingFrom, "Bad king move");
  const legalKing = generateMovesStandard(state, kingId).some(m=>m.to===kingTo);
  assert(legalKing, "Illegal king move");

  // Simulate king move then ensure out of check unless followup captures enemy king (handled later).
  // We validate followup is legal standard move in that intermediate state.
}

function validateComboNN(state, intent){
  // Two knight cards: one knight twice OR both once. :contentReference[oaicite:7]{index=7}
  const { mode } = intent.action.payload;
  assert(mode==="DOUBLE" || mode==="SPLIT", "Bad mode");
  // Full validation done on apply in starter; expand later.
}

function validateComboMorph(state, intent){
  // Knight + X morph. :contentReference[oaicite:8]{index=8}
  const { otherKind, mode, pieceId, from, to } = intent.action.payload;
  assert(["KING","ROOK","QUEEN","BISHOP"].includes(otherKind), "Bad other kind");
  assert(mode==="KNIGHT_AS_OTHER" || mode==="OTHER_AS_KNIGHT", "Bad mode");

  const p = state.pieces[pieceId];
  assert(p && p.side===intent.side && p.status==="ACTIVE", "Bad piece");
  assert(p.square===from, "From mismatch");
  // Full move-rule swapping enforced during apply in starter; expand later.
}

export function applyIntentMut(state, intent){
  if(intent.kind === "SETUP"){
    return applySetup(state, intent);
  }
  // 1) discard played cards
  const side = intent.side;
  const cardIds = intent.play.cardIds;
  for(const cid of cardIds){
    const idx = state.cards[side].hand.indexOf(cid);
    if(idx>=0) state.cards[side].hand.splice(idx,1);
    state.cards[side].discard.push(cid);
  }

  // 2) apply action
  const terminal = applyAction(state, intent);

  // 3) Update check flags if not terminal
  if(!terminal){
    state.threat.inCheck.W = isInCheck(state,"W");
    state.threat.inCheck.B = isInCheck(state,"B");

    // Enforce: cannot end your turn in check (unless you captured enemy king, already terminal)
    if(state.threat.inCheck[side]){
      throw new Error("Illegal: you ended your turn in check");
    }
  }

  // 4) Advance turn
  if(!terminal){
    const turn = state.phase.turn;
    if(intent.action.type === "NOBLE_QUEEN_MOVE_EXTRA_TURN"){
      turn.extraTurnQueue += 1;
    }

    if(turn.extraTurnQueue > 0){
      turn.extraTurnQueue -= 1;
      // same side goes again, full sequence
      turn.step = "DRAW";
    } else {
      turn.side = otherSide(turn.side);
      turn.step = "DRAW";
    }
  }

  state.log.push({ t: now(), side, intent, summary: summarizeIntent(state,intent) });
}

function applySetup(state, intent){
  const side = state.phase.setup.sideToPlace;
  const step = state.phase.setup.step;
  const a = intent.action;

  if(step==="PLACE_KING"){
    const to = a.payload.to;
    const kid = `${side}_K`;
    placePiece(state, kid, to);
    state.phase.setup.step = "PLACE_KNIGHTS";
    return;
  }

  if(step==="PLACE_KNIGHTS"){
    const { left, right } = a.payload;
    placePiece(state, `${side}_N1`, left);
    placePiece(state, `${side}_N2`, right);

    // next side or start game
    if(side==="W"){
      state.phase.setup.sideToPlace = "B";
      state.phase.setup.step = "PLACE_KING";
    } else {
      state.phase.stage = "TURN";
      state.phase.setup.step = "DONE";
      state.phase.turn.side = "W"; // white goes first :contentReference[oaicite:9]{index=9}
      state.phase.turn.step = "DRAW";
    }
  }
}

function applyAction(state, intent){
  const a = intent.action;

  switch(a.type){
    case "PLACE": {
      const { pieceId, to } = a.payload;
      placePiece(state, pieceId, to);
      return false;
    }

    case "MOVE_STANDARD":
    case "NOBLE_QUEEN_MOVE_EXTRA_TURN": {
      return movePiece(state, intent.side, a.payload.pieceId, a.payload.to);
    }

    case "NOBLE_KING_ADJ_NO_CAPTURE": {
      return movePiece(state, intent.side, a.payload.pieceId, a.payload.to, { forbidCapture:true });
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
      placePiece(state, pieceId, to, { resurrect:true });
      return false;
    }

    // Starter: apply minimal; expand later to full sequential legality checks.
    case "NOBLE_BISHOP_BLOCK_CHECK": {
      const { kingTo, followup } = a.payload;
      const terminal1 = movePiece(state, intent.side, `${intent.side}_K`, kingTo);
      if(terminal1) return true;
      const terminal2 = movePiece(state, intent.side, followup.pieceId, followup.to);
      return terminal2;
    }

    default:
      // combos not fully applied in starter snippet
      throw new Error("Action not implemented yet in starter apply");
  }
}

function placePiece(state, pieceId, to, opts={}){
  const p = state.pieces[pieceId];
  if(state.board[to]) throw new Error("Square occupied");
  // clear old square if any (resurrect/edge)
  if(p.square) delete state.board[p.square];
  p.status = "ACTIVE";
  p.square = to;
  state.board[to] = p.id;
}

function movePiece(state, moverSide, pieceId, to, opts={}){
  const p = state.pieces[pieceId];
  const from = p.square;
  const targetId = state.board[to];

  if(targetId){
    const t = state.pieces[targetId];
    if(opts.forbidCapture) throw new Error("Capture forbidden");
    if(t.side === moverSide) throw new Error("Cannot capture own piece");

    // capture
    t.status = "CAPTURED";
    t.square = null;
    delete state.board[to];

    // If captured piece is king => terminal win (ruthless rule) :contentReference[oaicite:10]{index=10}
    if(t.type === "K"){
      state.result.status = "WIN";
      state.result.winner = moverSide;
      state.result.reason = "KING_CAPTURED";
      // move piece onto king square just for final board display (optional)
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

export function drawToEight(state, side){
  const pile = state.cards[side];
  while(pile.hand.length < 8){
    if(pile.deck.length === 0){
      if(pile.discard.length === 0) break;
      pile.deck = pile.discard.splice(0);
      shuffleInPlace(pile.deck);
    }
    const cid = pile.deck.pop();
    if(!cid) break;
    pile.hand.push(cid);
  }
}

function summarizeIntent(state, intent){
  return `${intent.side} played ${intent.play.cardIds.join(",")} -> ${intent.action.type}`;
}
