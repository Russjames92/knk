// Single source of truth for card/combo naming and UI labels.
export const CARD_LABEL = {
  PAWN: "Pawn",
  KNIGHT: "Knight",
  KING: "King",
  ROOK: "Rook",
  QUEEN: "Queen",
  BISHOP: "Bishop",
};

export const ACTION_LABEL = {
  PLACE: "Place piece",
  MOVE_STANDARD: "Standard move",

  // Nobles
  NOBLE_KING_BACKRANK_KINGMOVE_NOCAP: "King Noble: Back-rank piece moves like King (no capture)",
  NOBLE_ROOK_SWAP_BACKRANK: "Rook Noble: Swap two back-rank pieces (no pawns)",
  NOBLE_QUEEN_ANY_MOVE_EXTRA_TURN: "Queen Noble: Any piece standard move + extra turn",
  NOBLE_BISHOP_RESURRECT: "Bishop Noble: Resurrect captured back-rank piece",
  NOBLE_BISHOP_BLOCK_CHECK: "Bishop Noble: Block Check (King move + standard move)",

  // Combos
  COMBO_NN: "Knight+Knight Combo",
  COMBO_NX_MORPH: "Knight+X Combo",
  COMBO_KING_KNIGHT: "King+Knight Combo (King moves like Knight)",
};

export function comboKey(kinds) {
  const sorted = [...kinds].sort();
  return sorted.join("+");
}

export function describeCombo(kinds) {
  const key = comboKey(kinds);
  if (key === "KNIGHT+KNIGHT") return "Knight+Knight";
  if (key === "KING+KNIGHT") return "King+Knight";
  if (key === "BISHOP+KNIGHT") return "Knight+Bishop";
  if (key === "KNIGHT+ROOK") return "Knight+Rook";
  if (key === "KNIGHT+QUEEN") return "Knight+Queen";
  if (key === "KING+KNIGHT") return "King+Knight";
  return key;
}
