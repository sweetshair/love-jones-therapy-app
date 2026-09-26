const { jsonResponse, parseJsonBody } = require("./_shared/http");
const { Timestamp, firestore, verifiedUser } = require("./_shared/firebase-admin");

function cleanId(value) {
  const result = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{8,180}$/.test(result)) throw new Error("The call information is invalid.");
  return result;
}

async function verifyCaller(db, userId, matchId, callId, allowTerminal = false) {
  const [matchSnapshot, callSnapshot] = await Promise.all([
    db.collection("matches").doc(matchId).get(),
    db.collection("matches").doc(matchId).collection("calls").doc(callId).get()
  ]);
  const match = matchSnapshot.data();
  const call = callSnapshot.data();
  if (!matchSnapshot.exists || !Array.isArray(match.memberIds) || !match.memberIds.includes(userId)) {
    throw new Error("This match is unavailable.");
  }
  const validStatus = call?.status === "active"
    || (allowTerminal && ["ended", "failed"].includes(call?.status));
  if (!callSnapshot.exists || call.callerId !== userId || !validStatus) {
    throw new Error("Only the caller can use purchased time on this call.");
  }
}

exports.handler = async event => {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed." });
  try {
    const user = await verifiedUser(event);
    if (!user) return jsonResponse(401, { error: "Sign in with a verified account first." });
    const body = parseJsonBody(event);
    const action = String(body.action || "");
    if (!["start", "heartbeat", "end"].includes(action)) {
      return jsonResponse(400, { error: "The paid-call action is invalid." });
    }
    const matchId = cleanId(body.matchId);
    const callId = cleanId(body.callId);
    const db = firestore();
    await verifyCaller(db, user.uid, matchId, callId, action === "end");
    const walletRef = db.collection("callWallets").doc(user.uid);
    const sessionRef = db.collection("paidCallSessions").doc(callId);
    const callRef = db.collection("matches").doc(matchId).collection("calls").doc(callId);
    const now = Timestamp.now();
    let result = null;

    await db.runTransaction(async transaction => {
      const [walletSnapshot, sessionSnapshot] = await Promise.all([
        transaction.get(walletRef),
        transaction.get(sessionRef)
      ]);
      const wallet = walletSnapshot.exists ? walletSnapshot.data() : {};
      let balanceSeconds = Math.max(0, Number(wallet.balanceSeconds) || 0);
      let spentSeconds = Math.max(0, Number(wallet.spentSeconds) || 0);
      const existing = sessionSnapshot.exists ? sessionSnapshot.data() : null;

      if (action === "start") {
        if (existing?.status === "active" && existing.ownerId === user.uid) {
          result = { balanceSeconds, billedSeconds: Number(existing.billedSeconds) || 0, status: "active" };
          return;
        }
        if (existing) throw new Error("Purchased time has already been used for this call.");
        if (balanceSeconds <= 0) throw new Error("Purchase call time before continuing this call.");
        transaction.create(sessionRef, {
          ownerId: user.uid,
          matchId,
          callId,
          status: "active",
          startedAt: now,
          billedSeconds: 0,
          createdAt: now,
          updatedAt: now
        });
        result = { balanceSeconds, billedSeconds: 0, status: "active" };
        return;
      }

      if (!existing || existing.ownerId !== user.uid || existing.status !== "active") {
        throw new Error("The paid-call session is not active.");
      }
      const startedAtMs = existing.startedAt?.toMillis?.() || now.toMillis();
      const elapsedSeconds = Math.max(0, Math.floor((now.toMillis() - startedAtMs) / 1000));
      const alreadyBilled = Math.max(0, Number(existing.billedSeconds) || 0);
      const dueSeconds = Math.max(0, elapsedSeconds - alreadyBilled);
      const chargedSeconds = Math.min(dueSeconds, balanceSeconds);
      balanceSeconds -= chargedSeconds;
      spentSeconds += chargedSeconds;
      const billedSeconds = alreadyBilled + chargedSeconds;
      const status = action === "end" ? "ended" : balanceSeconds <= 0 ? "exhausted" : "active";
      if (chargedSeconds > 0) {
        transaction.set(walletRef, {
          ownerId: user.uid,
          balanceSeconds,
          spentSeconds,
          updatedAt: now
        }, { merge: true });
      }
      transaction.update(sessionRef, {
        billedSeconds,
        status,
        updatedAt: now,
        ...(status !== "active" ? { endedAt: now } : {})
      });
      result = { balanceSeconds, billedSeconds, chargedSeconds, status };
    });

    if (action === "start") {
      await callRef.set({
        paidStatus: "active",
        paidBy: user.uid,
        paidStartedAt: now,
        updatedAt: now
      }, { merge: true });
    } else if (result?.status !== "active") {
      await callRef.set({
        paidStatus: result.status,
        paidEndedAt: now,
        updatedAt: now
      }, { merge: true });
    }

    return jsonResponse(200, result);
  } catch (error) {
    console.error("Paid call session failed:", error.message);
    const statusCode = /Purchase call time|balance/i.test(error.message) ? 402 : 400;
    return jsonResponse(statusCode, { error: error.message || "Purchased call time is unavailable." });
  }
};
