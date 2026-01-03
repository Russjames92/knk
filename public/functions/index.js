const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();
const db = admin.firestore();

const { applyIntentStrict, serverAdvanceDrawPhase } = require("./shared/engine/rules.cjs");

exports.submitIntent = functions.https.onCall(async (data, context) => {
  const { gameId, intent } = data || {};
  if (!gameId || !intent) {
    throw new functions.https.HttpsError("invalid-argument", "Missing gameId/intent");
  }

  const ref = db.collection("games").doc(gameId);

  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new functions.https.HttpsError("not-found", "Game not found");

    const doc = snap.data();
    let state = doc.state;
    const rev = doc.rev || 0;

    // Server-side: always advance DRAW -> PLAY automatically whenever needed.
    serverAdvanceDrawPhase(state);

    if (state.result?.status !== "ONGOING") {
      tx.update(ref, {
        state,
        rev: rev + 1,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        status: state.result.status
      });
      return { ok: true, rev: rev + 1, gameOver: true, result: state.result };
    }

    // Apply the submitted intent authoritatively
    let next;
    try{
      next = applyIntentStrict(state, intent);
    } catch (e){
      throw new functions.https.HttpsError("failed-precondition", e.message || "Illegal intent");
    }

    // After applying, server may need to handle DRAW->PLAY for next actor immediately
    serverAdvanceDrawPhase(next);

    tx.update(ref, {
      state: next,
      rev: rev + 1,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      status: next.result.status
    });

    return { ok: true, rev: rev + 1, result: next.result };
  });
});
