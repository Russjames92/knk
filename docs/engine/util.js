export const SIDES = ["W", "B"];

export function otherSide(side) { return side === "W" ? "B" : "W"; }
export function rankOf(sq) { return Number(sq[1]); }
export function fileOf(sq) { return sq[0]; }
export function inBounds(fileChar, rank) {
  return fileChar >= "a" && fileChar <= "h" && rank >= 1 && rank <= 8;
}
export function sq(fileChar, rank) { return `${fileChar}${rank}`; }
export function now() { return Date.now(); }
export function clone(obj) { return JSON.parse(JSON.stringify(obj)); }
export function assert(cond, msg) { if (!cond) throw new Error(msg); }
