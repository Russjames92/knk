const SIDES = ["W","B"];

function otherSide(side){ return side === "W" ? "B" : "W"; }
function rankOf(sq){ return Number(sq[1]); }
function fileOf(sq){ return sq[0]; }
function inBounds(fileChar, rank){
  return fileChar >= "a" && fileChar <= "h" && rank >= 1 && rank <= 8;
}
function sq(fileChar, rank){ return `${fileChar}${rank}`; }
function now(){ return Date.now(); }
function clone(obj){ return JSON.parse(JSON.stringify(obj)); }
function assert(cond, msg){ if(!cond) throw new Error(msg); }

module.exports = { SIDES, otherSide, rankOf, fileOf, inBounds, sq, now, clone, assert };
