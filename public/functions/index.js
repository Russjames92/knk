const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();
const db = admin.firestore();

exports.submitIntent = functions.https.onCall(async (data, context) => {
  const { gameId, intent } = data || {};
  if (!gameId || !intent) throw new functions.https.HttpsError("invalid-argument", "Missing gameId/intent");

  const ref = db.collection("games").doc(gameId);

  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new functions.https.HttpsError("not-found", "Game not found");

    const doc = snap.data();
    const state = doc.state;
    const rev = doc.rev || 0;

    // Minimal server validation gate:
    if (state.result?.status !== "ONGOING") throw new functions.https.HttpsError("failed-precondition", "Game over");
    if (state.phase?.stage !== "SETUP" && state.phase?.turn?.side !== intent.side) {
      throw new functions.https.HttpsError("failed-precondition", "Not your turn");
    }

    // TODO (next step): import a shared rules engine and do applyIntentStrict(state,intent)
    // For now, reject anything except SETUP to prove the wire works.
    if (intent.kind !== "SETUP") {
      throw new functions.https.HttpsError("unimplemented", "Server engine not wired yet. Next step will enable all intents.");
    }

    // Accept setup intents temporarily (you’ll replace with full shared validation next step)
    // Write back unchanged for now:
    tx.update(ref, { state, rev: rev + 1, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    return { ok: true, rev: rev + 1 };
  });
});
