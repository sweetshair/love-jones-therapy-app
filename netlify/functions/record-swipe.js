const { jsonResponse, parseJsonBody } = require("./_shared/http");
const { FieldValue, firestore, verifiedUser } = require("./_shared/firebase-admin");

function publicProfileSnapshot(profile = {}) {
  return {
    displayName: String(profile.displayName || "Member").slice(0, 30),
    age: Number(profile.age) || null,
    city: String(profile.city || "").slice(0, 60),
    region: String(profile.region || "").slice(0, 60),
    country: String(profile.country || "").slice(0, 60),
    bodyType: String(profile.bodyType || "").slice(0, 30),
    relationshipType: String(profile.relationshipType || "").slice(0, 10),
    photoPath: Array.isArray(profile.photoPaths) ? String(profile.photoPaths[0] || "") : ""
  };
}

function fail(message, statusCode = 403) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

exports.handler = async event => {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed." });
  try {
    const user = await verifiedUser(event);
    if (!user) return jsonResponse(401, { error: "Sign in with a verified account first." });

    const body = parseJsonBody(event);
    const targetId = String(body.targetId || "").trim();
    const decision = String(body.decision || "").trim();
    if (!targetId || targetId === user.uid || targetId.includes("/")) {
      return jsonResponse(400, { error: "That profile is unavailable." });
    }
    if (!["like", "pass"].includes(decision)) {
      return jsonResponse(400, { error: "Choose Like or Pass." });
    }

    const db = firestore();
    const ownUserRef = db.collection("users").doc(user.uid);
    const ownProfileRef = db.collection("datingProfiles").doc(user.uid);
    const targetProfileRef = db.collection("datingProfiles").doc(targetId);
    const targetDeletionRef = db.collection("accountDeletions").doc(targetId);
    const targetSuspensionRef = db.collection("accountSuspensions").doc(targetId);
    const outgoingBlockRef = db.collection("blocks").doc(`${user.uid}_${targetId}`);
    const incomingBlockRef = db.collection("blocks").doc(`${targetId}_${user.uid}`);
    const swipeRef = db.collection("swipes").doc(`${user.uid}_${targetId}`);
    const reverseRef = db.collection("swipes").doc(`${targetId}_${user.uid}`);
    const memberIds = [user.uid, targetId].sort();
    const matchId = memberIds.join("_");
    const matchRef = db.collection("matches").doc(matchId);

    const result = await db.runTransaction(async transaction => {
      const [
        ownUserSnap,
        ownProfileSnap,
        targetProfileSnap,
        targetDeletionSnap,
        targetSuspensionSnap,
        outgoingBlockSnap,
        incomingBlockSnap,
        swipeSnap,
        reverseSnap,
        matchSnap
      ] = await Promise.all([
        transaction.get(ownUserRef),
        transaction.get(ownProfileRef),
        transaction.get(targetProfileRef),
        transaction.get(targetDeletionRef),
        transaction.get(targetSuspensionRef),
        transaction.get(outgoingBlockRef),
        transaction.get(incomingBlockRef),
        transaction.get(swipeRef),
        transaction.get(reverseRef),
        transaction.get(matchRef)
      ]);

      if (!ownUserSnap.exists) fail("Complete your member account first.");
      const ownUser = ownUserSnap.data();
      if (ownUser.ageConfirmed !== true || !ownUser.termsAcceptedAt) {
        fail("Accept the member terms before using Discover People.");
      }

      if (!ownProfileSnap.exists) fail("Complete your dating profile first.");
      const ownProfile = ownProfileSnap.data();
      if (
        ownProfile.ownerId !== user.uid
        || ownProfile.active !== true
        || ownProfile.termsAccepted !== true
        || !Array.isArray(ownProfile.photoPaths)
        || ownProfile.photoPaths.length < 1
      ) {
        fail("Publish your completed dating profile before using Discover People.");
      }

      if (!targetProfileSnap.exists) fail("That profile is no longer available.", 404);
      const targetProfile = targetProfileSnap.data();
      if (targetProfile.ownerId !== targetId || targetProfile.active !== true) {
        fail("That profile is no longer available.", 404);
      }
      if (targetDeletionSnap.exists || targetSuspensionSnap.exists) {
        fail("That profile is no longer available.", 404);
      }
      if (outgoingBlockSnap.exists || incomingBlockSnap.exists) {
        fail("That member is blocked.", 403);
      }

      if (swipeSnap.exists) {
        const previous = swipeSnap.data();
        if (previous.fromId !== user.uid || previous.toId !== targetId) {
          fail("This swipe record is invalid.", 409);
        }
        transaction.set(swipeRef, {
          decision,
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
      } else {
        transaction.set(swipeRef, {
          fromId: user.uid,
          toId: targetId,
          decision,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp()
        });
      }

      let matched = false;
      if (
        decision === "like"
        && reverseSnap.exists
        && reverseSnap.data().fromId === targetId
        && reverseSnap.data().toId === user.uid
        && reverseSnap.data().decision === "like"
      ) {
        matched = true;
        if (!matchSnap.exists) {
          transaction.set(matchRef, {
            memberIds,
            status: "active",
            profileSnapshots: {
              [user.uid]: publicProfileSnapshot(ownProfile),
              [targetId]: publicProfileSnapshot(targetProfile)
            },
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp()
          });
        } else if (matchSnap.data().status !== "active") {
          matched = false;
        }
      }

      return { matched, matchId: matched ? matchId : "" };
    });

    return jsonResponse(200, result);
  } catch (error) {
    console.error("Swipe save failed:", error.message);
    return jsonResponse(error.statusCode || 500, {
      error: error.statusCode ? error.message : "Could not save your choice."
    });
  }
};
