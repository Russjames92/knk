// Single source of truth for card/combo semantics & labels.
// Engine uses these semantics; UI uses these labels.

export const CARD_KIND = {
  PAWN: "PAWN",
  KNIGHT: "KNIGHT",
  BISHOP: "BISHOP",
  ROOK: "ROOK",
  QUEEN: "QUEEN",
  KING: "KING",
};

// Human-readable labels for UI/logs
export const CARD_LABEL = {
  PAWN: "PAWN",
  KNIGHT: "KNIGHT",
  BISHOP: "BISHOP",
  ROOK: "ROOK",
  QUEEN: "QUEEN",
  KING: "KING",
};

export const ACTION_LABEL = {
  PLACE: "Place a piece",
  MOVE_STANDARD: "Standard move",
  NOBLE_KING_ADJ_NO_CAPTURE: "King Noble (adjacent, no capture)",
  NOBLE_ROOK_SWAP: "Rook Noble (swap two non-pawns)",
  NOBLE_QUEEN_MOVE_EXTRA_TURN: "Queen Noble (move + extra turn)",
  COMBO_NN: "Knight+Knight combo (double or split)",
  COMBO_NX_MORPH: "Knight+X combo (morph move)",
  COMBO_KING_KNIGHT: "King+Knight combo (King moves like a Knight)",
};

export function comboKeyFromKinds(kindA, kindB) {
  const a = String(kindA || "").toUpperCase();
  const b = String(kindB || "").toUpperCase();
  return [a, b].sort().join("+");
}

// Used for log clarity: tell what X is in Knight+X, etc.
export const COMBO_LABEL = {
  "KNIGHT+KNIGHT": "KNIGHT+KNIGHT",
  "BISHOP+KNIGHT": "KNIGHT+BISHOP",
  "KNIGHT+ROOK": "KNIGHT+ROOK",
  "KNIGHT+QUEEN": "KNIGHT+QUEEN",
  "KING+KNIGHT": "KING+KNIGHT",
};

// If the combo implies a specific "morph target", list it here.
export const COMBO_META = {
  "BISHOP+KNIGHT": { kind: "BISHOP", actionType: "COMBO_NX_MORPH", morphTarget: "BISHOP" },
  "KNIGHT+ROOK": { kind: "ROOK", actionType: "COMBO_NX_MORPH", morphTarget: "ROOK" },
  "KNIGHT+QUEEN": { kind: "QUEEN", actionType: "COMBO_NX_MORPH", morphTarget: "QUEEN" },
  "KING+KNIGHT": { kind: "KING", actionType: "COMBO_KING_KNIGHT", morphTarget: "KNIGHT" },
  "KNIGHT+KNIGHT": { kind: "KNIGHT", actionType: "COMBO_NN" },
};

export function describePlayFromState(state, play) {
  const ids = play?.cardIds || [];
  if (!ids.length) return "-";
  const kinds = ids.map((cid) => state?.cardMeta?.[cid]?.kind || cid);
  if (play?.type === "SINGLE") return `${kinds[0]} (${ids[0]})`;
  const k = [...kinds].sort().join("+");
  const id = [...ids].sort().join(",");
  return `${k} (${id})`;
}

export function describeAction(intent, state) {
  const t = intent?.action?.type || "?";
  if (t === "COMBO_NX_MORPH") {
    // infer X from the card kinds in the combo
    const ids = intent?.play?.cardIds || [];
    const kinds = ids.map((cid) => String(state?.cardMeta?.[cid]?.kind || "").toUpperCase());
    const hasKnight = kinds.includes("KNIGHT");
    if (!hasKnight) return "Knight+X morph";
    const x = kinds.find((k) => k !== "KNIGHT") || "X";
    return `Knight morphs to ${x} move`;
  }
  if (t === "COMBO_KING_KNIGHT") return "King moves like a Knight";
  return ACTION_LABEL[t] || t;
}
