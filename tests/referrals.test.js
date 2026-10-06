const { after, beforeEach, test } = require("node:test");
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
const app = initializeApp({ projectId }, "referral-tests");
const db = getFirestore(app);
const referrerId = "referrer_member_123";
const referredId = "referred_member_456";
const referralCode = "FOD-REFERRERME";

function handlerFor(uid, verified = true) {
  const filename = path.resolve(__dirname, "../netlify/functions/referrals.js");
  const localRequire = createRequire(filename);
  const sandbox = { exports:{}, console };
  vm.compileFunction(fs.readFileSync(filename, "utf8"), ["exports","require","console"], { filename })(
    sandbox.exports,
    name => name === "./_shared/firebase-admin"
      ? {
          Timestamp,
          firestore:() => db,
          authenticatedUser:async () => uid ? { uid, email_verified:verified } : null,
          verifiedUser:async () => uid && verified ? { uid, email_verified:true } : null
        }
      : localRequire(name),
    console
  );
  return sandbox.exports.handler;
}

function request(action, body = {}) {
  return {
    httpMethod:"POST",
    headers:{ authorization:"Bearer test" },
    body:JSON.stringify({ action, ...body })
  };
}

async function clean() {
  for (const collection of ["users","datingProfiles","referralClaims","callWallets","accountDeletions","accountSuspensions"]) {
    const snapshot = await db.collection(collection).get();
    await Promise.all(snapshot.docs
      .filter(doc => doc.id.includes("referrer_member") || doc.id.includes("referred_member")
        || doc.data().referrerId === referrerId || doc.data().referredId === referredId)
      .map(doc => doc.ref.delete()));
  }
}

beforeEach(async () => {
  await clean();
  await db.collection("users").doc(referrerId).set({
    referralCode,
    ageConfirmed:true,
    termsAcceptedAt:Timestamp.now(),
    relationshipType:"SB"
  });
  await db.collection("users").doc(referredId).set({
    ageConfirmed:true,
    termsAcceptedAt:Timestamp.now(),
    relationshipType:"GR"
  });
  await db.collection("datingProfiles").doc(referredId).set({
    ownerId:referredId,
    active:true,
    termsAccepted:true,
    photoPaths:[`profilePhotos/${referredId}/one.jpg`]
  });
});

after(async () => {
  await clean();
  await deleteApp(app);
});

test("a referral claim can be registered before email verification", async () => {
  const response = await handlerFor(referredId, false)(request("register", { referralCode }));
  assert.equal(response.statusCode, 200);
  const claim = await db.collection("referralClaims").doc(referredId).get();
  assert.equal(claim.exists, true);
  assert.equal(claim.data().referrerId, referrerId);
  assert.equal(claim.data().status, "pending");
});

test("qualification awards exactly three minutes to both members once", async () => {
  await handlerFor(referredId, false)(request("register", { referralCode }));
  const first = await handlerFor(referredId, true)(request("qualify"));
  assert.equal(first.statusCode, 200);
  assert.equal(JSON.parse(first.body).rewardSeconds, 180);

  for (const uid of [referrerId, referredId]) {
    const wallet = (await db.collection("callWallets").doc(uid).get()).data();
    assert.equal(wallet.balanceSeconds, 180);
    assert.equal(wallet.referralBonusSecondsAvailable, 180);
    assert.equal(wallet.referralBonusSecondsEarned, 180);
  }

  const second = await handlerFor(referredId, true)(request("qualify"));
  assert.equal(second.statusCode, 200);
  assert.equal(JSON.parse(second.body).alreadyAwarded, true);
  for (const uid of [referrerId, referredId]) {
    assert.equal((await db.collection("callWallets").doc(uid).get()).data().balanceSeconds, 180);
  }
});

test("an unpublished referred profile receives no reward", async () => {
  await handlerFor(referredId, false)(request("register", { referralCode }));
  await db.collection("datingProfiles").doc(referredId).update({ active:false });
  const response = await handlerFor(referredId, true)(request("qualify"));
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).awarded, false);
  assert.equal((await db.collection("callWallets").doc(referredId).get()).exists, false);
});
