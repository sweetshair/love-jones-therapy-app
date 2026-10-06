const { jsonResponse } = require("./_shared/http");
const { firestore, verifiedUser } = require("./_shared/firebase-admin");

function timeValue(value) {
  return value?.toMillis?.() || 0;
}

function publicProfile(id, data, likedAt) {
  const photoPaths = Array.isArray(data.photoPaths)
    ? data.photoPaths.filter(path => typeof path === "string").slice(0, 5)
    : [];
  return {
    id,
    displayName: String(data.displayName || "Member").slice(0, 30),
    age: Number(data.age) || null,
    city: String(data.city || "").slice(0, 60),
    region: String(data.region || "").slice(0, 60),
    country: String(data.country || "").slice(0, 60),
    gender: String(data.gender || "").slice(0, 40),
    lookingFor: String(data.lookingFor || "").slice(0, 60),
    relationshipGoal: String(data.relationshipGoal || "").slice(0, 80),
    bodyType: String(data.bodyType || "").slice(0, 40),
    relationshipType: String(data.relationshipType || "").slice(0, 10),
    bio: String(data.bio || "").slice(0, 1000),
    photoPaths,
    likedAt: likedAt?.toDate?.().toISOString?.() || null
  };
}

exports.handler = async event => {
  if (event.httpMethod !== "GET") return jsonResponse(405, { error: "Method not allowed." });
  try {
    const user = await verifiedUser(event);
    if (!user) return jsonResponse(401, { error: "Sign in with a verified account first." });

    const db = firestore();
    const [ownUserDoc, ownProfileDoc, incomingSnapshot, outgoingSnapshot, matchesSnapshot, outgoingBlocks, incomingBlocks] = await Promise.all([
      db.collection("users").doc(user.uid).get(),
      db.collection("datingProfiles").doc(user.uid).get(),
      db.collection("swipes").where("toId", "==", user.uid).limit(250).get(),
      db.collection("swipes").where("fromId", "==", user.uid).limit(250).get(),
      db.collection("matches").where("memberIds", "array-contains", user.uid).limit(80).get(),
      db.collection("blocks").where("blockerId", "==", user.uid).limit(250).get(),
      db.collection("blocks").where("blockedId", "==", user.uid).limit(250).get()
    ]);

    if (!ownUserDoc.exists || ownUserDoc.data()?.ageConfirmed !== true || !ownUserDoc.data()?.termsAcceptedAt) {
      return jsonResponse(403, { error: "Accept the member terms before viewing Likes You." });
    }
    if (!ownProfileDoc.exists) return jsonResponse(403, { error: "Complete your dating profile first." });
    const ownProfile = ownProfileDoc.data();
    if (
      ownProfile.ownerId !== user.uid
      || ownProfile.active !== true
      || ownProfile.termsAccepted !== true
      || !Array.isArray(ownProfile.photoPaths)
      || ownProfile.photoPaths.length < 1
    ) {
      return jsonResponse(403, { error: "Publish your completed dating profile before viewing Likes You." });
    }

    const blocked = new Set();
    outgoingBlocks.forEach(item => blocked.add(item.data().blockedId));
    incomingBlocks.forEach(item => blocked.add(item.data().blockerId));

    const existingMatches = new Set();
    matchesSnapshot.forEach(item => {
      const otherId = item.data().memberIds?.find(id => id !== user.uid);
      if (otherId) existingMatches.add(otherId);
    });

    const outgoing = new Map();
    outgoingSnapshot.forEach(item => {
      const data = item.data();
      if (data.toId) outgoing.set(data.toId, {
        decision: data.decision,
        time: timeValue(data.updatedAt || data.createdAt)
      });
    });

    const pending = [];
    incomingSnapshot.forEach(item => {
      const data = item.data();
      if (data.decision !== "like" || !data.fromId || data.fromId === user.uid) return;
      if (blocked.has(data.fromId) || existingMatches.has(data.fromId)) return;
      const incomingTime = timeValue(data.updatedAt || data.createdAt);
      const response = outgoing.get(data.fromId);
      if (response && response.time >= incomingTime) return;
      pending.push({
        id: data.fromId,
        likedAt: data.updatedAt || data.createdAt || null
      });
    });

    const profiles = [];
    for (const like of pending.slice(0, 100)) {
      const [profileDoc, deletionDoc, suspensionDoc] = await Promise.all([
        db.collection("datingProfiles").doc(like.id).get(),
        db.collection("accountDeletions").doc(like.id).get(),
        db.collection("accountSuspensions").doc(like.id).get()
      ]);
      if (deletionDoc.exists || suspensionDoc.exists || !profileDoc.exists) continue;
      const profile = profileDoc.data();
      if (profile.ownerId !== like.id || profile.active !== true) continue;
      profiles.push(publicProfile(like.id, profile, like.likedAt));
    }

    profiles.sort((a, b) => Date.parse(b.likedAt || "") - Date.parse(a.likedAt || ""));
    return jsonResponse(200, { profiles });
  } catch (error) {
    console.error("Likes You load failed:", error.message);
    return jsonResponse(500, { error: "Could not load the people who Like you." });
  }
};
