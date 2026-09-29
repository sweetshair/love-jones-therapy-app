const { jsonResponse, parseJsonBody } = require("./_shared/http");
const { Timestamp, firestore, verifiedUser } = require("./_shared/firebase-admin");

const FREE_CALL_SECONDS = 180;
const RECONNECT_WINDOW_MS = 60 * 1000;
const RING_TIMEOUT_MS = 20 * 1000;
const ACTIVE_FREE_TIMEOUT_MS = (FREE_CALL_SECONDS + 60) * 1000;
const ACTIVE_PAID_TIMEOUT_MS = 45 * 1000;
const FREE_PROGRAM_START_MS = Date.parse("2026-09-22T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

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

async function verifiedReconnect(transaction, matchRef, userId, mode, sessionId) {
  const snapshot = await transaction.get(matchRef.collection("calls")
    .where("freeSessionId", "==", sessionId)
    .limit(20));
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

async function freeAllowance(transaction, db, userId, mode, matches) {
  const snapshots = await Promise.all(matches.map(match => transaction.get(
    match.ref.collection("calls").where("callerId", "==", userId).limit(100)
  )));
  const sessions = new Map();
  snapshots.forEach(snapshot => snapshot.forEach(item => {
    const call = item.data();
    const answeredAt = call.answeredAt?.toMillis?.();
    if (call.mode !== mode || call.billingMode === "paid" || answeredAt < FREE_PROGRAM_START_MS) return;
    const sessionId = String(call.freeSessionId || item.id);
    sessions.set(sessionId, Math.min(answeredAt, sessions.get(sessionId) || answeredAt));
  }));
  const answered = [...sessions.values()].sort((a, b) => a - b);
  if (!answered.length) return;
  const startsAt = answered[0];
  const elapsed = Date.now() - startsAt;
  if (elapsed >= 30 * DAY_MS) throw new Error(`Your introductory ${mode === "audio" ? "voice" : "video"} calls have ended.`);
  const period = elapsed < 7 * DAY_MS ? [0, 7] : elapsed < 14 * DAY_MS ? [7, 14]
    : elapsed < 21 * DAY_MS ? [14, 21] : [21, 30];
  const used = answered.filter(time => time >= startsAt + period[0] * DAY_MS && time < startsAt + period[1] * DAY_MS).length;
  if (used >= 2) throw new Error(`Both free ${mode === "audio" ? "voice" : "video"} calls for this allowance period have been used.`);
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
    const callRef = matchRef.collection("calls").doc();
    const allowanceRef = db.collection("freeCallReservations").doc(`${user.uid}_${mode}`);
    let freeSessionId = callRef.id;
    let freeSeconds = billingMode === "paid" ? 0 : FREE_CALL_SECONDS;
    const requestedSessionId = String(body.freeSessionId || "").trim();
    if (billingMode === "free" && requestedSessionId) {
      freeSessionId = cleanId(requestedSessionId, "The free call session");
    }
    await db.runTransaction(async transaction => {
      const [matchSnapshot, outgoingBlock, incomingBlock, openCalls, memberMatches, allowanceReservation] = await Promise.all([
        transaction.get(matchRef),
        transaction.get(db.collection("blocks").doc(`${user.uid}_${calleeId}`)),
        transaction.get(db.collection("blocks").doc(`${calleeId}_${user.uid}`)),
        transaction.get(matchRef.collection("calls").where("status", "in", ["ringing", "active"])),
        transaction.get(db.collection("matches").where("memberIds", "array-contains", user.uid).limit(80)),
        transaction.get(allowanceRef)
      ]);
      const match = matchSnapshot.data();
      if (
        !matchSnapshot.exists
        || match.status !== "active"
        || !Array.isArray(match.memberIds)
        || match.memberIds.length !== 2
        || !match.memberIds.includes(user.uid)
        || !match.memberIds.includes(calleeId)
        || outgoingBlock.exists
        || incomingBlock.exists
      ) throw new Error("This match is unavailable.");

      if (billingMode === "paid") {
        const walletSnapshot = await transaction.get(db.collection("callWallets").doc(user.uid));
        if (Math.max(0, Number(walletSnapshot.data()?.balanceSeconds) || 0) <= 0) {
          throw new Error("Purchase call time before placing this call.");
        }
      }
      if (billingMode === "free" && requestedSessionId) {
        const remainingSeconds = await verifiedReconnect(transaction, matchRef, user.uid, mode, freeSessionId);
        freeSeconds = Math.min(
          remainingSeconds,
          Math.max(1, Math.floor(Number(body.freeSeconds) || remainingSeconds))
        );
      }
      if (billingMode === "free" && !requestedSessionId) {
        const reservedUntil = allowanceReservation.data()?.reservedUntil?.toMillis?.() || 0;
        if (reservedUntil > Date.now()) {
          const reservedCallId = String(allowanceReservation.data()?.callId || "");
          const reservedMatchId = String(allowanceReservation.data()?.matchId || "");
          const reservedCall = reservedCallId && reservedMatchId
            ? await transaction.get(db.collection("matches").doc(reservedMatchId).collection("calls").doc(reservedCallId))
            : null;
          if (!reservedCall?.exists || ["ringing", "active"].includes(reservedCall.data().status)) {
            const error = new Error("Another free call is already being prepared.");
            error.statusCode = 409;
            throw error;
          }
        }
        await freeAllowance(transaction, db, user.uid, mode,
          memberMatches.docs.filter(item => item.data().status === "active"));
      }

      const now = Timestamp.now();
      const expiredRinging = [];
      for (const snapshot of openCalls.docs) {
        const call = snapshot.data();
        const createdAt = call.createdAt?.toMillis?.();
        const updatedAt = call.updatedAt?.toMillis?.() || createdAt;
        const activeTimeout = call.billingMode === "paid" ? ACTIVE_PAID_TIMEOUT_MS : ACTIVE_FREE_TIMEOUT_MS;
        if ((call.status === "ringing" && Number.isFinite(createdAt) && now.toMillis() - createdAt >= RING_TIMEOUT_MS)
          || (call.status === "active" && Number.isFinite(updatedAt) && now.toMillis() - updatedAt >= activeTimeout)) {
          expiredRinging.push(snapshot.ref);
        } else {
          const error = new Error("A call is already in progress with this match. Answer the incoming call or wait for it to end.");
          error.statusCode = 409;
          throw error;
        }
      }
      for (const expiredRef of expiredRinging) {
        transaction.update(expiredRef, { status:"failed", endedAt:now, updatedAt:now, expiryReason:"liveness_timeout" });
      }
      // Every reservation writes this same document, including the first call.
      // Competing transactions retry and see the winning call before creating one.
      // Querying open calls also protects calls created before this reservation existed.
      transaction.update(matchRef, { activeCallId:callRef.id });
      if (billingMode === "free" && !requestedSessionId) {
        transaction.set(allowanceRef, {
          ownerId:user.uid, mode, matchId, callId:callRef.id,
          reservedUntil:Timestamp.fromMillis(now.toMillis() + RING_TIMEOUT_MS), updatedAt:now
        });
      }
      transaction.create(callRef, {
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
    });
    return jsonResponse(200, { callId:callRef.id, freeSessionId, freeSeconds, billingMode });
  } catch (error) {
    console.error("Call signal creation failed:", error.message);
    const statusCode = error.statusCode === 409 ? 409 : /Sign in/i.test(error.message) ? 401 : /Purchase call time/i.test(error.message) ? 402 : 400;
    return jsonResponse(statusCode, { error:error.message || "The call could not start." });
  }
};
