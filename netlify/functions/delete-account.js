const { jsonResponse, parseJsonBody } = require("./_shared/http");
const { Timestamp, firestore, authenticatedUser, authAdmin, firebaseApp } = require("./_shared/firebase-admin");
const { getStorage } = require("firebase-admin/storage");
const { createHash } = require("node:crypto");
const { SUPPORTED_LANGUAGES } = require("./translate-message");

// Enable only after BOTH deletion-aware Firestore and Storage rules are published.
// A persistent server-only tombstone blocks stale tokens and late wallet credits.
const enabled = () => process.env.ACCOUNT_DELETION_ENABLED === "true";

async function removeTree(db, ref) {
  // Keep the parent until every child collection is gone, so interrupted cleanup
  // remains discoverable and a retry cannot overlook orphaned subcollections.
  for (const collection of await ref.listCollections()) await db.recursiveDelete(collection);
  await ref.delete();
}

async function cleanAccountStep(db, uid, bucket, auth) {
  const matches = await db.collection("matches").where("memberIds", "array-contains", uid).limit(1).get();
  if (!matches.empty) {
    const ref = matches.docs[0].ref;
    await ref.update({ status: "closed", closedBy: uid, updatedAt: Timestamp.now() });
    // Delete derived translations before source messages so a retry can still
    // derive every cache key. Shared cache misses are safe to regenerate.
    const messages = await ref.collection("messages").limit(20).get();
    if (!messages.empty) {
      const batch = db.batch();
      for (const message of messages.docs) {
        const text = String(message.data().text || "").trim();
        for (const target of SUPPORTED_LANGUAGES) {
          const id = createHash("sha256").update(`v1\0${target}\0${text}`).digest("hex");
          batch.delete(db.collection("messageTranslationCache").doc(id));
        }
        batch.delete(message.ref);
      }
      await batch.commit();
      return false;
    }
    await removeTree(db, ref);
    return false;
  }
  for (const [collection, field] of [
    ["swipes", "fromId"], ["swipes", "toId"],
    ["blocks", "blockerId"], ["blocks", "blockedId"],
    ["freeCallReservations", "ownerId"], ["paidCallSessions", "ownerId"],
    ["referralClaims", "referredId"], ["referralClaims", "referrerId"]
  ]) {
    const records = await db.collection(collection).where(field, "==", uid).limit(100).get();
    if (!records.empty) {
      const batch = db.batch();
      records.docs.forEach(record => batch.delete(record.ref));
      await batch.commit();
      return false;
    }
  }
  // Exact UID prefix: never accept a storage path or target UID from the client.
  const [files] = await bucket.getFiles({ prefix: `profilePhotos/${uid}/`, maxResults: 100, autoPaginate: false });
  if (files.length) {
    await Promise.all(files.map(file => file.delete({ ignoreNotFound: true })));
    return false;
  }
  await removeTree(db, db.collection("users").doc(uid));
  await db.collection("datingProfiles").doc(uid).delete();
  await db.collection("callWallets").doc(uid).delete();
  // Auth is last: an interrupted deletion can be resumed with the same account.
  try { await auth.deleteUser(uid); }
  catch (error) { if (error.code !== "auth/user-not-found") throw error; }
  await db.collection("accountDeletions").doc(uid).set({ status: "complete", completedAt: Timestamp.now() }, { merge: true });
  return true;
}

exports.handler = async event => {
  if (event.httpMethod === "GET") return jsonResponse(200, { enabled: enabled() });
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed." });
  if (!enabled()) return jsonResponse(503, { error: "Account deletion is awaiting its security update. Please try again once setup is complete." });
  try {
    const body = parseJsonBody(event);
    if (body.confirmation !== "DELETE" || Object.keys(body).some(key => key !== "confirmation")) {
      return jsonResponse(400, { error: "Type DELETE to confirm deletion of your signed-in account." });
    }
    // Signature/expiry check also permits idempotent recovery if Auth deletion
    // succeeded but the last response or completion write was interrupted.
    const identity = await authenticatedUser(event, false);
    if (!identity) return jsonResponse(401, { error: "Sign in first." });
    const db = firestore();
    const ref = db.collection("accountDeletions").doc(identity.uid);
    const existing = await ref.get();
    if (existing.data()?.status === "complete") return jsonResponse(200, { deleted: true });
    try { await authenticatedUser(event, true); }
    catch (error) {
      if (!(error.code === "auth/user-not-found" && existing.exists)) throw error;
    }
    const age = Date.now() / 1000 - Number(identity.auth_time);
    if (!Number.isFinite(age) || age < -60 || age > 600) {
      return jsonResponse(401, { error: "Enter your password again to continue deleting your account." });
    }
    if (!existing.exists) {
      await db.runTransaction(async transaction => {
        const [deletion, profile] = await Promise.all([
          transaction.get(ref), transaction.get(db.collection("datingProfiles").doc(identity.uid))
        ]);
        if (deletion.exists) return;
        const matches = await transaction.get(db.collection("matches").where("memberIds", "array-contains", identity.uid));
        for (const match of matches.docs) {
          const calls = await transaction.get(match.ref.collection("calls").where("status", "in", ["ringing", "active"]));
          if (calls.docs.some(item => {
            const call = item.data();
            const updated = call.updatedAt?.toMillis?.() || call.createdAt?.toMillis?.() || Date.now();
            const timeout = call.status === "ringing" ? 30000 : call.billingMode === "paid" ? 60000 : 240000;
            return Date.now() - updated < timeout;
          })) throw Object.assign(new Error("Finish your call, wait a minute, then retry Delete Account."), { code: "deletion/call-active" });
        }
        transaction.create(ref, { status: "pending", requestedAt: Timestamp.now() });
        if (profile.exists) transaction.update(profile.ref, { active: false });
      });
    }
    const bucket = getStorage(firebaseApp()).bucket("love-jones-therapy-app.firebasestorage.app");
    const deleted = await cleanAccountStep(db, identity.uid, bucket, authAdmin());
    return jsonResponse(deleted ? 200 : 202, { deleted, pending: !deleted });
  } catch (error) {
    // Never log tokens, passwords, member IDs, or profile contents.
    if (error.code === "deletion/call-active") return jsonResponse(409, { error: error.message });
    const authError = String(error.code || "").startsWith("auth/");
    return jsonResponse(authError ? 401 : 503, {
      error: authError ? "Please sign in again and retry account deletion."
        : "Deletion did not finish. Retry Delete Account to resume safely; do not create a new account yet."
    });
  }
};

exports.cleanAccountStep = cleanAccountStep;
