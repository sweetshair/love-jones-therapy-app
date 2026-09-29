const { jsonResponse } = require("./_shared/http");
const { firestore, verifiedUser } = require("./_shared/firebase-admin");

function preferenceAllows(preference, gender) {
  return !preference || preference === "Everyone" || (preference === "Women" && gender === "Woman")
    || (preference === "Men" && gender === "Man")
    || (preference === "Nonbinary people" && ["Nonbinary", "Prefer to self describe"].includes(gender));
}
function ageAllows(preferences, age) {
  const minimum = Number(preferences?.minPreferredAge) || 18;
  const maximum = Number(preferences?.maxPreferredAge) || 99;
  return Number.isInteger(Number(age)) && Number(age) >= minimum && Number(age) <= maximum;
}
function bodyAllows(preferences, bodyType) {
  const values = Array.isArray(preferences?.preferredBodyTypes) ? preferences.preferredBodyTypes : [];
  return !values.length || values.includes("Open to all body types") || !bodyType
    || bodyType === "Prefer not to say" || values.includes(bodyType);
}

exports.handler = async event => {
  if (event.httpMethod !== "GET") return jsonResponse(405, { error:"Method not allowed." });
  try {
    const user = await verifiedUser(event);
    if (!user) return jsonResponse(401, { error:"Sign in with a verified account first." });
    const db = firestore();
    const [ownProfileDoc, ownUserDoc, profiles, users, outgoing, incoming, outgoingBlocks, incomingBlocks] = await Promise.all([
      db.collection("datingProfiles").doc(user.uid).get(), db.collection("users").doc(user.uid).get(),
      db.collection("datingProfiles").where("active", "==", true).get(), db.collection("users").get(),
      db.collection("swipes").where("fromId", "==", user.uid).limit(250).get(),
      db.collection("swipes").where("toId", "==", user.uid).limit(250).get(),
      db.collection("blocks").where("blockerId", "==", user.uid).limit(250).get(),
      db.collection("blocks").where("blockedId", "==", user.uid).limit(250).get()
    ]);
    if (!ownProfileDoc.exists) return jsonResponse(400, { error:"Complete your dating profile first." });
    const own = ownProfileDoc.data();
    const ownPreferences = ownUserDoc.data()?.datingPreferences || {};
    const privatePreferences = new Map(users.docs.map(item => [item.id, item.data().datingPreferences || {}]));
    const decisions = new Map(outgoing.docs.map(item => [item.data().toId, item.data().decision]));
    const likes = new Set(incoming.docs.filter(item => item.data().decision === "like").map(item => item.data().fromId));
    const blocked = new Set([...outgoingBlocks.docs.map(item => item.data().blockedId), ...incomingBlocks.docs.map(item => item.data().blockerId)]);
    const activeIds = new Set(profiles.docs.map(item => item.id));
    const visible = profiles.docs.filter(item => {
      const candidate = item.data();
      const candidatePreferences = privatePreferences.get(item.id) || {};
      const likedYou = likes.has(item.id);
      return item.id !== user.uid && !blocked.has(item.id) && (!decisions.has(item.id) || likedYou)
        && preferenceAllows(own.lookingFor, candidate.gender) && preferenceAllows(candidate.lookingFor, own.gender)
        && ageAllows(ownPreferences, candidate.age) && ageAllows(candidatePreferences, own.age)
        && bodyAllows(ownPreferences, candidate.bodyType) && bodyAllows(candidatePreferences, own.bodyType);
    }).map(item => ({ id:item.id, ...item.data(), likedYou:likes.has(item.id) }));
    return jsonResponse(200, { profiles:visible, status:{ incomingLikes:likes.size,
      visibleIncomingLikes:visible.filter(profile => profile.likedYou).length,
      unavailableIncomingLikes:[...likes].filter(id => id !== user.uid && !activeIds.has(id) && !blocked.has(id)).length } });
  } catch (error) {
    console.error("Profile discovery failed:", error.message);
    return jsonResponse(500, { error:"Profiles could not be loaded." });
  }
};
