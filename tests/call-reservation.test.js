const { before, after, beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { initializeApp, deleteApp } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const { initializeTestEnvironment, assertFails, assertSucceeds } = require("@firebase/rules-unit-testing");
const { doc, setDoc, updateDoc, serverTimestamp } = require("firebase/firestore");

// Refuse to use a real project or credentials. Authentication is stubbed, but
// transactions and permission checks run against the real Firestore emulator.
const emulator = process.env.FIRESTORE_EMULATOR_HOST;
assert.match(emulator || "", /^(127\.0\.0\.1|localhost):\d+$/, "Start the local Firestore emulator first.");
const projectId = "demo-fod-call-tests";
const callerId = "caller_member_123";
const calleeId = "callee_member_456";
const matchId = "test_match_123456";
const adminApp = initializeApp({ projectId }, "call-reservation-tests");
const db = getFirestore(adminApp);
const matchRef = db.collection("matches").doc(matchId);
const calls = matchRef.collection("calls");
let environment;

function handlerFor(uid = callerId) {
  const filename = path.resolve(__dirname, "../netlify/functions/create-call-signal.js");
  const localRequire = createRequire(filename);
  const sandbox = {
    exports: {},
    console,
    require: name => name === "./_shared/firebase-admin"
      ? { Timestamp, firestore: () => db, verifiedUser: async () => uid ? { uid } : null }
      : localRequire(name)
  };
  // Keep native Promises in Firestore's realm; only replace authentication.
  vm.compileFunction(fs.readFileSync(filename, "utf8"), ["exports", "require", "console"], { filename })(
    sandbox.exports, sandbox.require, sandbox.console
  );
  return sandbox.exports.handler;
}

function request(overrides = {}) {
  return { httpMethod: "POST", body: JSON.stringify({
    matchId, calleeId, mode: "audio", offer: { type: "offer", sdp: "test-offer" }, ...overrides
  }) };
}

async function seedCall(status, ageSeconds = 0, extras = {}) {
  const ref = calls.doc();
  await ref.set({ callerId, calleeId, mode: "audio", status,
    offer: { type: "offer", sdp: "test-offer" },
    createdAt: Timestamp.fromMillis(Date.now() - ageSeconds * 1000),
    updatedAt: Timestamp.now(), ...extras });
  return ref;
}

before(async () => {
  const [host, port] = emulator.split(":");
  environment = await initializeTestEnvironment({ projectId,
    firestore: { host, port: Number(port), rules: fs.readFileSync(path.resolve(__dirname, "../firestore.rules"), "utf8") }
  });
});
beforeEach(async () => {
  await environment.clearFirestore();
  await matchRef.set({ memberIds: [callerId, calleeId], status: "active" });
});
after(async () => { await environment?.cleanup(); await deleteApp(adminApp); });

test("simultaneous cross-calls admit exactly one caller", async () => {
  const results = await Promise.all([
    handlerFor(callerId)(request()),
    handlerFor(calleeId)(request({ calleeId: callerId }))
  ]);
  assert.deepEqual(results.map(result => result.statusCode).sort(), [200, 409]);
  const open = await calls.where("status", "in", ["ringing", "active"]).get();
  assert.equal(open.size, 1);
});

test("a duplicate request cannot displace the ringing call", async () => {
  const first = await handlerFor()(request());
  const second = await handlerFor()(request());
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 409);
  assert.equal((await calls.get()).size, 1);
});

test("a recent active call stays reserved", async () => {
  const active = await seedCall("active", 30);
  assert.equal((await handlerFor()(request())).statusCode, 409);
  assert.equal((await active.get()).data().status, "active");
});

test("an orphaned free active call expires and permits recovery", async () => {
  const active = await seedCall("active", 300);
  assert.equal((await handlerFor()(request())).statusCode, 200);
  assert.equal((await active.get()).data().status, "failed");
});

test("abandoned ringing expires and permits the next call", async () => {
  const abandoned = await seedCall("ringing", 30);
  assert.equal((await handlerFor()(request())).statusCode, 200);
  const expired = (await abandoned.get()).data();
  assert.equal(expired.status, "failed");
  assert.ok(expired.endedAt);
  assert.equal((await calls.where("status", "==", "ringing").get()).size, 1);
});

test("each terminal status permits a new call", async () => {
  for (const status of ["ended", "failed", "declined", "missed"]) await seedCall(status, 30);
  assert.equal((await handlerFor()(request())).statusCode, 200);
});

test("closed matches and either direction of blocking reject calls", async () => {
  await matchRef.update({ status: "closed" });
  assert.equal((await handlerFor()(request())).statusCode, 400);
  await matchRef.update({ status: "active" });
  for (const blockId of [`${callerId}_${calleeId}`, `${calleeId}_${callerId}`]) {
    const block = db.collection("blocks").doc(blockId);
    await block.set({});
    assert.equal((await handlerFor()(request())).statusCode, 400);
    await block.delete();
  }
  assert.equal((await calls.get()).size, 0);
});

test("unauthenticated and nonmember requests cannot create calls", async () => {
  assert.equal((await handlerFor(null)(request())).statusCode, 401);
  assert.equal((await handlerFor("unrelated_member")(request())).statusCode, 400);
  assert.equal((await calls.get()).size, 0);
});

test("free reconnection keeps the remaining allowance", async () => {
  const now = Date.now();
  await seedCall("ended", 50, { freeSessionId: "free_session_123", billingMode: "free",
    answeredAt: Timestamp.fromMillis(now - 45000), endedAt: Timestamp.fromMillis(now - 5000) });
  const result = await handlerFor()(request({ freeSessionId: "free_session_123", freeSeconds: 180 }));
  assert.equal(result.statusCode, 200);
  assert.equal(JSON.parse(result.body).freeSeconds, 140);
});

test("server rejects the third answered voice call while video remains separate", async () => {
  const now = Date.now();
  for (let index = 0; index < 2; index += 1) {
    await seedCall("ended", 5, { mode:"audio", billingMode:"free", freeSessionId:`voice_session_${index}`,
      answeredAt:Timestamp.fromMillis(now - 60000 + index), endedAt:Timestamp.fromMillis(now - 30000 + index) });
  }
  assert.equal((await handlerFor()(request({ mode:"audio" }))).statusCode, 400);
  assert.equal((await handlerFor()(request({ mode:"video" }))).statusCode, 200);
});

test("paid reservation requires a balance and does not spend it", async () => {
  assert.equal((await handlerFor()(request({ billingMode: "paid" }))).statusCode, 402);
  const wallet = db.collection("callWallets").doc(callerId);
  await wallet.set({ balanceSeconds: 600 });
  const result = await handlerFor()(request({ billingMode: "paid" }));
  assert.equal(result.statusCode, 200);
  assert.equal(JSON.parse(result.body).freeSeconds, 0);
  assert.equal((await wallet.get()).data().balanceSeconds, 600);
});

test("clients cannot bypass reservation with a direct call create", async () => {
  const client = environment.authenticatedContext(callerId, { email_verified: true }).firestore();
  await assertFails(setDoc(doc(client, "matches", matchId, "calls", "direct_call_123"), {
    callerId, calleeId, mode: "audio", status: "ringing", offer: { type: "offer", sdp: "offer" },
    createdAt: serverTimestamp(), updatedAt: serverTimestamp()
  }));
});

test("callee can answer and caller can end a reserved call", async () => {
  const result = await handlerFor()(request());
  assert.equal(result.statusCode, 200);
  const callId = JSON.parse(result.body).callId;
  const callee = environment.authenticatedContext(calleeId, { email_verified: true }).firestore();
  await assertSucceeds(updateDoc(doc(callee, "matches", matchId, "calls", callId), {
    answer: { type: "answer", sdp: "answer" }, status: "active",
    answeredAt: serverTimestamp(), updatedAt: serverTimestamp()
  }));
  const caller = environment.authenticatedContext(callerId, { email_verified: true }).firestore();
  await assertSucceeds(updateDoc(doc(caller, "matches", matchId, "calls", callId), {
    status: "ended", endedAt: serverTimestamp(), updatedAt: serverTimestamp()
  }));
  assert.equal((await handlerFor()(request())).statusCode, 200);
});
