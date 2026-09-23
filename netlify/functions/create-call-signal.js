const { jsonResponse, parseJsonBody } = require("./_shared/http");
const { Timestamp, firestore, verifiedUser } = require("./_shared/firebase-admin");

const FREE_CALL_SECONDS = 180;
const RECONNECT_WINDOW_MS = 60 * 1000;

function cleanId(value, label) {
  const result = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{8,180}$/.test(result)) throw new Error(`${label} is invalid.`);
  return result;
}

function cleanOffer(value) {
  const type = String(value?.type || "");
  const sdp = String(value?.sdp || "");
  if (type !== "offer" || !sdp || sdp.length > 20000) {
    throw new Error("The call connection information is invalid.");
  }
  return { type, sdp };
}

function callDurationSeconds(call) {
  const answeredAt = call?.answeredAt?.toMillis?.();
  const endedAt = call?.endedAt?.toMillis?.();
  if (!answeredAt || !endedAt || endedAt <= answeredAt) return 0;
  return Math.max(0, Math.ceil((endedAt - answeredAt) / 1000));
}

async function verifiedReconnect(db, matchId, userId, mode, sessionId) {
  const snapshot = await db.collection("matches").doc(matchId).collection("calls")
    .where("freeSessionId", "==", sessionId)
    .limit(20)
    .get();
  if (snapshot.empty) throw new Error("The reconnection period is no longer available.");
  let usedSeconds = 0;
  let latestEndedAt = 0;
  snapshot.forEach(item => {
    const call = item.data();
    if (call.callerId !== userId || call.mode !== mode || call.billingMode === "paid") return;
    usedSeconds += callDurationSeconds(call);
    latestEndedAt = Math.max(latestEndedAt, call.endedAt?.toMillis?.() || 0);
  });
  if (!latestEndedAt || Date.now() - latestEndedAt > RECONNECT_WINDOW_MS) {
    throw new Error("The 60-second reconnection period has ended.");
  }
  const remainingSeconds = Math.max(0, FREE_CALL_SECONDS - usedSeconds);
  if (remainingSeconds <= 0) throw new Error("That free call has no time remaining.");
  return remainingSeconds;
}

exports.handler = async event => {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed." });
  try {
    const user = await verifiedUser(event);
    if (!user) return jsonResponse(401, { error: "Sign in with a verified account first." });
    const body = parseJsonBody(event);
    const matchId = cleanId(body.matchId, "The match");
    const calleeId = cleanId(body.calleeId, "The member");
    const mode = String(body.mode || "");
    if (!["audio", "video"].includes(mode)) throw new Error("Choose a voice or video call.");
    if (calleeId === user.uid) throw new Error("That member cannot be called.");
    const offer = cleanOffer(body.offer);
    const billingMode = body.billingMode === "paid" ? "paid" : "free";
    const db = firestore();
    const matchRef = db.collection("matches").doc(matchId);
    const matchSnapshot = await matchRef.get();
    const memberIds = matchSnapshot.data()?.memberIds;
    if (
      !matchSnapshot.exists
      || !Array.isArray(memberIds)
      || !memberIds.includes(user.uid)
      || !memberIds.includes(calleeId)
    ) throw new Error("This match is unavailable.");

    if (billingMode === "paid") {
      const walletSnapshot = await db.collection("callWallets").doc(user.uid).get();
      if (Math.max(0, Number(walletSnapshot.data()?.balanceSeconds) || 0) <= 0) {
        throw new Error("Purchase call time before placing this call.");
      }
    }

    const callRef = matchRef.collection("calls").doc();
    let freeSessionId = callRef.id;
    let freeSeconds = billingMode === "paid" ? 0 : FREE_CALL_SECONDS;
    const requestedSessionId = String(body.freeSessionId || "").trim();
    if (billingMode === "free" && requestedSessionId) {
      const cleanSessionId = cleanId(requestedSessionId, "The free call session");
      const remainingSeconds = await verifiedReconnect(db, matchId, user.uid, mode, cleanSessionId);
      freeSessionId = cleanSessionId;
      freeSeconds = Math.min(
        remainingSeconds,
        Math.max(1, Math.floor(Number(body.freeSeconds) || remainingSeconds))
      );
    }
    const now = Timestamp.now();
    await callRef.create({
      callerId:user.uid,
      calleeId,
      mode,
      billingMode,
      freeSessionId,
      freeSeconds,
      status:"ringing",
      offer,
      createdAt:now,
      updatedAt:now
    });
    return jsonResponse(200, { callId:callRef.id, freeSessionId, freeSeconds, billingMode });
  } catch (error) {
    console.error("Call signal creation failed:", error.message);
    const statusCode = /Sign in/i.test(error.message) ? 401 : /Purchase call time/i.test(error.message) ? 402 : 400;
    return jsonResponse(statusCode, { error:error.message || "The call could not start." });
  }
};
