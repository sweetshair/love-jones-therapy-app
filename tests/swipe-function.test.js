const { before, after, beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { initializeApp, deleteApp } = require("firebase-admin/app");
const { FieldValue, getFirestore, Timestamp } = require("firebase-admin/firestore");

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
assert.match(emulator || "", /^(127\.0\.0\.1|localhost):\d+$/, "Start the local Firestore emulator first.");
const projectId = "demo-fod-call-tests";
const app = initializeApp({ projectId }, "swipe-function-tests");
const db = getFirestore(app);
const callerId = "swipe_caller";
const targetId = "swipe_target";

function handlerFor(uid = callerId, verified = true) {
  const filename = path.resolve(__dirname, "../netlify/functions/record-swipe.js");
  const localRequire = createRequire(filename);
  const sandbox = { exports: {}, console };
  vm.compileFunction(fs.readFileSync(filename, "utf8"), ["exports", "require", "console"], { filename })(
    sandbox.exports,
    name => name === "./_shared/firebase-admin"
      ? {
          FieldValue,
          firestore: () => db,
          verifiedUser: async () => verified && uid ? { uid, email_verified: true } : null
        }
      : localRequire(name),
    console
  );
  return sandbox.exports.handler;
}

function request(target = targetId, decision = "like") {
  return {
    httpMethod: "POST",
    headers: { authorization: "Bearer test" },
    body: JSON.stringify({ targetId: target, decision })
  };
}

async function seedMember(uid, displayName) {
  await db.collection("users").doc(uid).set({
    ageConfirmed: true,
    termsAcceptedAt: Timestamp.now()
  });
  await db.collection("datingProfiles").doc(uid).set({
    ownerId: uid,
    active: true,
    termsAccepted: true,
    photoPaths: [`profilePhotos/${uid}/one.jpg`],
    displayName,
    age: 40,
    city: "Toronto",
    region: "ON",
    country: "Canada",
    relationshipType: "SB"
  });
}

beforeEach(async () => {
  const collections = await db.listCollections();
  await Promise.all(collections.map(async collection => {
    const snapshots = await collection.listDocuments();
    await Promise.all(snapshots.map(ref => ref.delete()));
  }));
  await seedMember(callerId, "Caller");
  await seedMember(targetId, "Target");
});

after(async () => { await deleteApp(app); });

test("server swipe creates the first Like for an eligible verified member", async () => {
  const response = await handlerFor()(request());
  assert.equal(response.statusCode, 200);
  const saved = await db.collection("swipes").doc(`${callerId}_${targetId}`).get();
  assert.equal(saved.exists, true);
  assert.equal(saved.data().decision, "like");
});

test("mutual Likes create one deterministic active match", async () => {
  await db.collection("swipes").doc(`${targetId}_${callerId}`).set({
    fromId: targetId,
    toId: callerId,
    decision: "like",
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now()
  });
  const response = await handlerFor()(request());
  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.body);
  assert.equal(payload.matched, true);
  const match = await db.collection("matches").doc([callerId, targetId].sort().join("_")).get();
  assert.equal(match.exists, true);
  assert.equal(match.data().status, "active");
});

test("server swipe refuses blocked, suspended and unpublished targets", async () => {
  await db.collection("blocks").doc(`${callerId}_${targetId}`).set({ blockerId: callerId, blockedId: targetId });
  assert.equal((await handlerFor()(request())).statusCode, 403);
  await db.collection("blocks").doc(`${callerId}_${targetId}`).delete();

  await db.collection("accountSuspensions").doc(targetId).set({ reason: "test" });
  assert.equal((await handlerFor()(request())).statusCode, 404);
  await db.collection("accountSuspensions").doc(targetId).delete();

  await db.collection("datingProfiles").doc(targetId).update({ active: false });
  assert.equal((await handlerFor()(request())).statusCode, 404);
});
