import { otherSide, fileOf, rankOf, inBounds, sq } from "./util.js";

const FILES = ["a","b","c","d","e","f","g","h"];

export function isSquareOccupied(state, square){
  return !!state.board[square];
}

export function pieceAt(state, square){
  const pid = state.board[square];
  return pid ? state.pieces[pid] : null;
}

export function generateMovesStandard(state, pieceId){
  const p = state.pieces[pieceId];
  if(!p || p.status !== "ACTIVE") return [];
  const from = p.square;
  const side = p.side;
  const moves = [];

  if(p.type === "N"){
    const deltas = [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]];
    for(const [df, dr] of deltas){
      const f = FILES.indexOf(fileOf(from));
      const r = rankOf(from);
      const nf = FILES[f+df];
      const nr = r+dr;
      if(!nf || !inBounds(nf,nr)) continue;
      const to = sq(nf,nr);
      const occ = pieceAt(state,to);
      if(!occ || occ.side !== side) moves.push({from,to});
    }
    return moves;
  }

  if(p.type === "K"){
    for(let df=-1;df<=1;df++){
      for(let dr=-1;dr<=1;dr++){
        if(df===0 && dr===0) continue;
        const f = FILES.indexOf(fileOf(from));
        const r = rankOf(from);
        const nf = FILES[f+df];
        const nr = r+dr;
        if(!nf || !inBounds(nf,nr)) continue;
        const to = sq(nf,nr);
        const occ = pieceAt(state,to);
        if(!occ || occ.side !== side) moves.push({from,to});
      }
    }
    return moves;
  }

  // Sliding pieces: R, B, Q
  const rays = [];
  if(p.type === "R" || p.type === "Q") rays.push([1,0],[-1,0],[0,1],[0,-1]);
  if(p.type === "B" || p.type === "Q") rays.push([1,1],[1,-1],[-1,1],[-1,-1]);

  if(rays.length){
    for(const [df,dr] of rays){
      let f = FILES.indexOf(fileOf(from));
      let r = rankOf(from);
      while(true){
        f += df; r += dr;
        const nf = FILES[f];
        if(!nf || !inBounds(nf,r)) break;
        const to = sq(nf,r);
        const occ = pieceAt(state,to);
        if(!occ){
          moves.push({from,to});
          continue;
        }
        if(occ.side !== side) moves.push({from,to});
        break;
      }
    }
    return moves;
  }

  // Pawn
  if(p.type === "P"){
    const dir = side === "W" ? 1 : -1;
    const startRank = side === "W" ? 2 : 7;
    const f = FILES.indexOf(fileOf(from));
    const r = rankOf(from);

    // forward 1
    const fwd1 = sq(FILES[f], r+dir);
    if(inBounds(FILES[f], r+dir) && !isSquareOccupied(state,fwd1)){
      moves.push({from,to:fwd1});
      // forward 2 from start
      const fwd2 = sq(FILES[f], r+2*dir);
      if(r===startRank && !isSquareOccupied(state,fwd2)) moves.push({from,to:fwd2});
    }

    // captures
    for(const df of [-1,1]){
      const nf = FILES[f+df];
      const nr = r+dir;
      if(!nf || !inBounds(nf,nr)) continue;
      const to = sq(nf,nr);
      const occ = pieceAt(state,to);
      if(occ && occ.side !== side) moves.push({from,to});
    }
    return moves;
  }

  return moves;
}

export function attacksSquare(state, attackerPieceId, targetSquare){
  // For check detection: use standard move generator and see if target is reachable as a capture ray.
  const p = state.pieces[attackerPieceId];
  if(!p || p.status !== "ACTIVE") return false;

  // Special pawn attack rule: pawn attacks diagonals, not forward move squares.
  if(p.type === "P"){
    const dir = p.side === "W" ? 1 : -1;
    const f = FILES.indexOf(fileOf(p.square));
    const r = rankOf(p.square);
    const diag1 = FILES[f-1] ? sq(FILES[f-1], r+dir) : null;
    const diag2 = FILES[f+1] ? sq(FILES[f+1], r+dir) : null;
    return targetSquare === diag1 || targetSquare === diag2;
  }

  return generateMovesStandard(state, attackerPieceId).some(m => m.to === targetSquare);
}

export function findKingSquare(state, side){
  const kid = `${side}_K`;
  const k = state.pieces[kid];
  return k?.status==="ACTIVE" ? k.square : null;
}

export function isInCheck(state, side){
  const kingSq = findKingSquare(state, side);
  if(!kingSq) return false;
  const opp = otherSide(side);
  for(const pid of Object.keys(state.pieces)){
    const p = state.pieces[pid];
    if(p.side !== opp || p.status !== "ACTIVE") continue;
    if(attacksSquare(state, pid, kingSq)) return true;
  }
  return false;
}
