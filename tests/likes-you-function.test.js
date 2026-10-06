const { before, after, beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { initializeApp, deleteApp } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
assert.match(emulator || "", /^(127\.0\.0\.1|localhost):\d+$/, "Start the local Firestore emulator first.");
const projectId = "demo-fod-call-tests";
const app = initializeApp({ projectId }, "likes-you-tests");
const db = getFirestore(app);
const ownerId = "likes_you_owner";
const senderId = "likes_you_sender";

function handlerFor(uid = ownerId, verified = true) {
  const filename = path.resolve(__dirname, "../netlify/functions/likes-you.js");
  const localRequire = createRequire(filename);
  const sandbox = { exports: {}, console };
  vm.compileFunction(fs.readFileSync(filename, "utf8"), ["exports", "require", "console"], { filename })(
    sandbox.exports,
    name => name === "./_shared/firebase-admin"
      ? {
          firestore: () => db,
          verifiedUser: async () => verified && uid ? { uid, email_verified: true } : null
        }
      : localRequire(name),
    console
  );
  return sandbox.exports.handler;
}

async function seedProfile(uid, name) {
  await db.collection("users").doc(uid).set({
    ageConfirmed: true,
    termsAcceptedAt: Timestamp.now()
  });
  await db.collection("datingProfiles").doc(uid).set({
    ownerId: uid,
    active: true,
    termsAccepted: true,
    photoPaths: [`profilePhotos/${uid}/one.jpg`],
    displayName: name,
    age: 40,
    city: "Toronto",
    region: "ON",
    country: "Canada",
    relationshipType: "SB"
  });
}

async function clean() {
  for (const collection of ["users","datingProfiles","swipes","matches","blocks","accountDeletions","accountSuspensions"]) {
    const snapshot = await db.collection(collection).get();
    const refs = snapshot.docs.filter(doc => {
      const data = doc.data();
      return doc.id.includes("likes_you_")
        || data.fromId === ownerId || data.fromId === senderId
        || data.toId === ownerId || data.toId === senderId
        || data.blockerId === ownerId || data.blockerId === senderId
        || data.blockedId === ownerId || data.blockedId === senderId
        || data.memberIds?.includes?.(ownerId) || data.memberIds?.includes?.(senderId);
    });
    await Promise.all(refs.map(doc => doc.ref.delete()));
  }
}

beforeEach(async () => {
  await clean();
  await seedProfile(ownerId, "Owner");
  await seedProfile(senderId, "Sender");
});

after(async () => {
  await clean();
  await deleteApp(app);
});

test("Likes You returns a pending active incoming Like", async () => {
  await db.collection("swipes").doc(`${senderId}_${ownerId}`).set({
    fromId: senderId,
    toId: ownerId,
    decision: "like",
    createdAt: Timestamp.fromMillis(Date.now() - 1000),
    updatedAt: Timestamp.now()
  });
  const response = await handlerFor()({ httpMethod: "GET", headers: { authorization: "Bearer test" } });
  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.body);
  assert.equal(payload.profiles.length, 1);
  assert.equal(payload.profiles[0].id, senderId);
  assert.equal(payload.profiles[0].displayName, "Sender");
  assert.equal("email" in payload.profiles[0], false);
});

test("Likes You hides a Like after a newer response", async () => {
  const older = Timestamp.fromMillis(Date.now() - 2000);
  const newer = Timestamp.now();
  await db.collection("swipes").doc(`${senderId}_${ownerId}`).set({
    fromId: senderId, toId: ownerId, decision: "like", createdAt: older, updatedAt: older
  });
  await db.collection("swipes").doc(`${ownerId}_${senderId}`).set({
    fromId: ownerId, toId: senderId, decision: "pass", createdAt: newer, updatedAt: newer
  });
  const response = await handlerFor()({ httpMethod: "GET", headers: { authorization: "Bearer test" } });
  assert.equal(JSON.parse(response.body).profiles.length, 0);
});

test("Likes You hides blocked, suspended and already matched members", async () => {
  const swipe = {
    fromId: senderId, toId: ownerId, decision: "like",
    createdAt: Timestamp.now(), updatedAt: Timestamp.now()
  };
  await db.collection("swipes").doc(`${senderId}_${ownerId}`).set(swipe);
  await db.collection("blocks").doc(`${ownerId}_${senderId}`).set({ blockerId: ownerId, blockedId: senderId });
  let response = await handlerFor()({ httpMethod: "GET", headers: { authorization: "Bearer test" } });
  assert.equal(JSON.parse(response.body).profiles.length, 0);

  await db.collection("blocks").doc(`${ownerId}_${senderId}`).delete();
  await db.collection("accountSuspensions").doc(senderId).set({ reason: "test" });
  response = await handlerFor()({ httpMethod: "GET", headers: { authorization: "Bearer test" } });
  assert.equal(JSON.parse(response.body).profiles.length, 0);

  await db.collection("accountSuspensions").doc(senderId).delete();
  await db.collection("matches").doc([ownerId, senderId].sort().join("_")).set({
    memberIds: [ownerId, senderId].sort(),
    status: "active"
  });
  response = await handlerFor()({ httpMethod: "GET", headers: { authorization: "Bearer test" } });
  assert.equal(JSON.parse(response.body).profiles.length, 0);
});
