const { before, after, beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { initializeApp, deleteApp } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const { initializeTestEnvironment, assertFails, assertSucceeds } = require("@firebase/rules-unit-testing");
const { deleteDoc, doc, getDoc, getDocs, collection, query, where, setDoc, updateDoc, serverTimestamp } = require("firebase/firestore");

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
    firestore: { host, port: Number(port), rules: fs.readFileSync(path.resolve(__dirname, "../firestore.rules"), "utf8") },
    storage: { host: "127.0.0.1", port: 9199, rules: fs.readFileSync(path.resolve(__dirname, "../storage.rules"), "utf8") }
  });
});
beforeEach(async () => {
  await environment.clearFirestore();
  await matchRef.set({ memberIds: [callerId, calleeId], status: "active" });
  for (const uid of [callerId, calleeId]) {
    await db.collection("users").doc(uid).set({ ageConfirmed: true, termsAcceptedAt: Timestamp.now() });
    await db.collection("datingProfiles").doc(uid).set({ ownerId: uid, active: true });
  }
});
after(async () => { await environment?.cleanup(); await deleteApp(adminApp); });

test('moderation transactions record decisions, reject stale edits, and only target the saved report member', async () => {
  const {applyAction}=require('../netlify/functions/moderate-reports');
  const report=db.doc('reports/moderation_test');
  await report.set({targetId:callerId,reporterId:calleeId,status:'new',createdAt:Timestamp.now()});
  const body={reportId:report.id,version:0,action:'status',status:'under_review',note:'Review in progress'};
  await applyAction(db,'admin',body,['admin'],true);
  assert.equal((await report.get()).data().status,'under_review');
  await assert.rejects(applyAction(db,'admin',body,['admin'],true),error=>error.status===409);
  assert.equal((await db.collection('moderationAudit').get()).size,1);
  await applyAction(db,'admin',{...body,version:1,action:'suspend',confirmation:'SUSPEND',targetId:calleeId},['admin'],true);
  assert.equal((await db.doc(`accountSuspensions/${callerId}`).get()).exists,true);
  assert.equal((await db.doc(`accountSuspensions/${calleeId}`).get()).exists,false);
  assert.equal((await db.doc(`datingProfiles/${callerId}`).get()).data().active,false);
  await assertFails(getDoc(doc(memberClient(),'users',callerId)));
  await assertFails(updateDoc(doc(memberClient(),'datingProfiles',callerId),{active:true}));
  await assertFails(setDoc(doc(memberClient(calleeId),'matches',matchId,'messages','suspended_message'),{
    senderId:calleeId,text:'Test',createdAt:serverTimestamp()}));
  assert.notEqual((await handlerFor(calleeId)(request({calleeId:callerId}))).statusCode,200);
  assert.notEqual((await handlerFor(callerId)(request())).statusCode,200);
  await applyAction(db,'admin',{...body,version:2,action:'restore',confirmation:'RESTORE'},['admin'],true);
  assert.equal((await db.doc(`accountSuspensions/${callerId}`).get()).exists,false);
  assert.equal((await db.doc(`datingProfiles/${callerId}`).get()).data().active,false);
  await assertSucceeds(getDoc(doc(memberClient(),'users',callerId)));
  assert.equal((await db.collection('moderationAudit').get()).size,3);
});

test('moderation cannot suspend administrators or deleted members and client moderation data stays private',async()=>{
  const {applyAction}=require('../netlify/functions/moderate-reports');
  const report=db.doc('reports/protected_report');
  await report.set({targetId:callerId,reporterId:calleeId,status:'new'});
  const body={reportId:report.id,version:0,action:'suspend',confirmation:'SUSPEND',note:'Reviewed'};
  await assert.rejects(applyAction(db,'admin',body,['admin',callerId],true),error=>error.status===403);
  await db.doc(`accountDeletions/${callerId}`).set({status:'pending'});
  await assert.rejects(applyAction(db,'admin',body,['admin'],true),error=>error.status===409);
  assert.equal((await db.collection('moderationAudit').get()).size,0);
  const client=memberClient(calleeId);
  for(const name of ['reports','moderationAudit','accountSuspensions']) {
    await assertFails(getDoc(doc(client,name,'protected_report')));
    await assertFails(setDoc(doc(client,name,'protected_report'),{status:'resolved'}));
  }
});

test('administrator report list paginates and excludes private member fields',async()=>{
  const filename=path.resolve(__dirname,'../netlify/functions/moderate-reports.js');
  const localRequire=createRequire(filename);const result={};
  vm.compileFunction(fs.readFileSync(filename,'utf8'),['exports','require','process'],{filename})(result,
    name=>name==='./_shared/firebase-admin'?{Timestamp,firestore:()=>db,
      authenticatedUser:async()=>({uid:'admin',email_verified:true})}:localRequire(name),
    {env:{MODERATOR_UIDS:'admin'}});
  await db.doc(`datingProfiles/${callerId}`).update({displayName:'Test Member',email:'private@example.test'});
  const batch=db.batch();
  for(let i=0;i<27;i++) batch.set(db.doc(`reports/report_${String(i).padStart(2,'0')}`),{
    targetId:callerId,reporterId:calleeId,status:'new',reason:'Other',details:'Test',createdAt:Timestamp.now(),secret:'private'});
  await batch.commit();
  const first=await result.handler({httpMethod:'GET'});
  assert.equal(first.statusCode,200);
  const page=JSON.parse(first.body);assert.equal(page.reports.length,25);assert.equal(page.next,'report_24');
  assert.equal(page.reports[0].memberName,'Test Member');assert.equal(first.body.includes('private'),false);
  const second=JSON.parse((await result.handler({httpMethod:'GET',queryStringParameters:{after:page.next}})).body);
  assert.equal(second.reports.length,2);assert.equal(second.next,null);
});

test('suspension hides Storage photos and denies old-token uploads; restoration permits owner access',async()=>{
  const owner=environment.authenticatedContext(callerId,{email_verified:true}).storage();
  const other=environment.authenticatedContext(calleeId,{email_verified:true}).storage();
  const photo=`profilePhotos/${callerId}/suspension-test.jpg`;
  await assertSucceeds(owner.ref(photo).put(new Uint8Array([1]),{contentType:'image/jpeg'}));
  await assertSucceeds(other.ref(photo).getMetadata());
  await db.doc(`accountSuspensions/${callerId}`).set({reason:'Emulator test'});
  await assertFails(owner.ref(photo).getMetadata());
  await assertFails(owner.ref(photo).put(new Uint8Array([1]),{contentType:'image/jpeg'}));
  await assertFails(other.ref(photo).getMetadata());
  await db.doc(`accountSuspensions/${callerId}`).delete();
  await assertSucceeds(owner.ref(photo).getMetadata());
});

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

function memberClient(uid = callerId, verified = true) {
  return environment.authenticatedContext(uid, { email_verified: verified }).firestore();
}

test("first Like and Pass can read missing swipes and save without exposing others", async () => {
  const client = memberClient();
  const id = callerId + "_" + calleeId;
  const ref = doc(client, "swipes", id);
  assert.equal((await assertSucceeds(getDoc(ref))).exists(), false);
  assert.equal((await assertSucceeds(getDoc(doc(client, "swipes", calleeId + "_" + callerId)))).exists(), false);
  await assertSucceeds(setDoc(ref, { fromId: callerId, toId: calleeId, decision: "like",
    createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
  await assertSucceeds(setDoc(ref, { decision: "pass", updatedAt: serverTimestamp() }, { merge: true }));
  assert.equal((await assertSucceeds(getDoc(ref))).data().decision, "pass");
  const reverse = doc(memberClient(calleeId), "swipes", calleeId + "_" + callerId);
  await assertSucceeds(setDoc(reverse, { fromId: calleeId, toId: callerId, decision: "pass",
    createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
  assert.equal((await assertSucceeds(getDocs(query(collection(client, "swipes"),
    where("fromId", "==", callerId))))).size, 1);
  await db.collection("swipes").doc("other_a_other_b").set({ fromId: "other_a", toId: "other_b", decision: "like" });
  await assertFails(getDoc(doc(client, "swipes", "other_a_other_b")));
  await assertFails(getDocs(collection(client, "swipes")));
});

test("swipes require verified email, age, Terms and an owned active profile", async () => {
  const id = callerId + "_" + calleeId;
  async function denied(client) {
    await assertFails(getDoc(doc(client, "swipes", id)));
    await assertFails(setDoc(doc(client, "swipes", id), { fromId: callerId, toId: calleeId,
      decision: "like", createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
  }
  await denied(environment.unauthenticatedContext().firestore());
  await denied(memberClient(callerId, false));
  for (const patch of [{ ageConfirmed: false }, { termsAcceptedAt: null }]) {
    await db.collection("users").doc(callerId).set(patch, { merge: true });
    await denied(memberClient());
    await db.collection("users").doc(callerId).set({ ageConfirmed: true, termsAcceptedAt: Timestamp.now() });
  }
  for (const patch of [{ active: false }, { ownerId: calleeId }]) {
    await db.collection("datingProfiles").doc(callerId).set(patch, { merge: true });
    await denied(memberClient());
    await db.collection("datingProfiles").doc(callerId).set({ ownerId: callerId, active: true });
  }
});

test("messages and call updates retain email, age and Terms gates", async () => {
  const call = await seedCall("ringing");
  async function denied(client) {
    await assertFails(getDoc(doc(client, "matches", matchId, "calls", call.id)));
    await assertFails(updateDoc(doc(client, "matches", matchId, "calls", call.id), {
      status: "ended", endedAt: serverTimestamp(), updatedAt: serverTimestamp() }));
    await assertFails(setDoc(doc(client, "matches", matchId, "messages", "gated_message"), {
      senderId: callerId, text: "Test", createdAt: serverTimestamp() }));
  }
  await denied(memberClient(callerId, false));
  for (const patch of [{ ageConfirmed: false }, { termsAcceptedAt: null }]) {
    await db.collection("users").doc(callerId).set(patch, { merge: true });
    await denied(memberClient());
    await db.collection("users").doc(callerId).set({ ageConfirmed: true, termsAcceptedAt: Timestamp.now() });
  }
  await assertSucceeds(setDoc(doc(memberClient(), "matches", matchId, "messages", "allowed_message"), {
    senderId: callerId, text: "Test", createdAt: serverTimestamp() }));
});

test("both block directions deny client messages and call access", async () => {
  const call = await seedCall("ringing");
  const client = memberClient();
  for (const id of [callerId + "_" + calleeId, calleeId + "_" + callerId]) {
    const block = db.collection("blocks").doc(id);
    await block.set({});
    await assertFails(getDoc(doc(client, "matches", matchId, "calls", call.id)));
    await assertFails(setDoc(doc(client, "matches", matchId, "messages", "blocked_message"), {
      senderId: callerId, text: "Test", createdAt: serverTimestamp() }));
    await block.delete();
  }
});

test("wallet, purchase and paid-session reads are owner-only and writes are server-only", async () => {
  for (const [name, id] of [["callWallets", callerId], ["callPurchases", "purchase_123"], ["paidCallSessions", "paid_123"]]) {
    await db.collection(name).doc(id).set({ ownerId: callerId, balanceSeconds: 600 });
    await assertSucceeds(getDoc(doc(memberClient(), name, id)));
    await assertFails(getDoc(doc(memberClient(calleeId), name, id)));
    await assertFails(getDoc(doc(environment.unauthenticatedContext().firestore(), name, id)));
    await assertFails(updateDoc(doc(memberClient(), name, id), { balanceSeconds: 9999 }));
    await assertFails(setDoc(doc(memberClient(), name, "forged_record"), { ownerId: callerId }));
  }
});

test("reservation and translation cache collections remain inaccessible to clients", async () => {
  for (const name of ["freeCallReservations", "messageTranslationCache"]) {
    await db.collection(name).doc("private_record").set({ ownerId: callerId });
    await assertFails(getDoc(doc(memberClient(), name, "private_record")));
    await assertFails(setDoc(doc(memberClient(), name, "private_record"), { ownerId: callerId }));
  }
});

test("members can list and remove their own blocks without removing reciprocal blocks", async () => {
  const owner = environment.authenticatedContext(callerId, { email_verified: true }).firestore();
  const other = environment.authenticatedContext(calleeId, { email_verified: true }).firestore();
  const ownPath = `blocks/${callerId}_${calleeId}`;
  const reversePath = `blocks/${calleeId}_${callerId}`;
  await db.doc(ownPath).set({ blockerId: callerId, blockedId: calleeId, createdAt: Timestamp.now() });
  await db.doc(reversePath).set({ blockerId: calleeId, blockedId: callerId, createdAt: Timestamp.now() });
  const listed = await assertSucceeds(getDocs(query(collection(owner, "blocks"), where("blockerId", "==", callerId))));
  assert.equal(listed.size, 1);
  await assertFails(deleteDoc(doc(other, ownPath)));
  await assertFails(deleteDoc(doc(environment.unauthenticatedContext().firestore(), ownPath)));
  await assertSucceeds(deleteDoc(doc(owner, ownPath)));
  assert.equal((await db.doc(reversePath).get()).exists, true);
});


test("deletion tombstone blocks stale tokens, recreation, and a new call to the member", async () => {
  await db.collection('accountDeletions').doc(callerId).set({status:'pending'});
  const client=environment.authenticatedContext(callerId,{email_verified:true}).firestore();
  await assertFails(getDoc(doc(client,'users',callerId)));
  await assertFails(setDoc(doc(client,'users',callerId),{ageConfirmed:true,termsAcceptedAt:serverTimestamp()}));
  await assertFails(setDoc(doc(client,'accountDeletions',callerId),{status:'complete'}));
  await assertFails(deleteDoc(doc(client,'accountDeletions',callerId)));
  await assertFails(getDoc(doc(client,'callWallets',callerId)));
  const response=await handlerFor(calleeId)(request({calleeId:callerId}));
  assert.notEqual(response.statusCode,200);
  assert.equal((await calls.get()).size,0);
});

test("account cleanup resumes after storage failure and preserves other accounts and retained records", async () => {
  const {cleanAccountStep}=require('../netlify/functions/delete-account');
  await db.collection('accountDeletions').doc(callerId).set({status:'pending'});
  await db.collection('users').doc(callerId).collection('results').doc('quiz').set({private:true});
  await matchRef.collection('messages').doc('message').set({text:'private'});
  const translationId=require('node:crypto').createHash('sha256').update('v1\0fr\0private').digest('hex');
  await db.collection('messageTranslationCache').doc(translationId).set({translation:'private translation'});
  const call=await seedCall('ended');
  await call.collection('callerCandidates').doc('ice').set({candidate:'private'});
  await db.collection('swipes').doc('like').set({fromId:calleeId,toId:callerId});
  await db.collection('blocks').doc('block').set({blockerId:callerId,blockedId:calleeId});
  await db.collection('callWallets').doc(callerId).set({balanceSeconds:900});
  await db.collection('callWallets').doc(calleeId).set({balanceSeconds:120});
  await db.collection('callPurchases').doc('receipt').set({ownerId:callerId,status:'paid'});
  await db.collection('reports').doc('report').set({targetId:callerId,reason:'Other'});
  const removed=[];let storageFails=true;let hasPhoto=true;
  const bucket={getFiles:async options=>{
    assert.equal(options.prefix,`profilePhotos/${callerId}/`);
    if(storageFails) throw Error('Storage unavailable');
    return [hasPhoto?[{delete:async()=>{hasPhoto=false;}}]:[]];
  }};
  const auth={deleteUser:async uid=>removed.push(uid)};
  for(let step=0;step<4;step++) assert.equal(await cleanAccountStep(db,callerId,bucket,auth),false);
  await assert.rejects(cleanAccountStep(db,callerId,bucket,auth),/Storage unavailable/);
  assert.deepEqual(removed,[]);
  assert.equal((await db.collection('accountDeletions').doc(callerId).get()).data().status,'pending');
  storageFails=false;
  assert.equal(await cleanAccountStep(db,callerId,bucket,auth),false);
  assert.equal(await cleanAccountStep(db,callerId,bucket,auth),true);
  assert.deepEqual(removed,[callerId]);
  assert.equal((await call.collection('callerCandidates').get()).size,0);
  assert.equal((await matchRef.collection('messages').get()).size,0);
  assert.equal((await db.collection('messageTranslationCache').doc(translationId).get()).exists,false);
  assert.equal((await db.collection('users').doc(callerId).collection('results').get()).size,0);
  for(const collection of ['users','datingProfiles','callWallets']) {
    assert.equal((await db.collection(collection).doc(callerId).get()).exists,false);
    assert.equal((await db.collection(collection).doc(calleeId).get()).exists,true);
  }
  assert.equal((await db.collection('callPurchases').doc('receipt').get()).exists,true);
  assert.equal((await db.collection('reports').doc('report').get()).exists,true);
  assert.equal((await db.collection('accountDeletions').doc(callerId).get()).data().status,'complete');
});


test("late Stripe payment records a receipt without recreating a deleted wallet", async () => {
  await db.collection('accountDeletions').doc(callerId).set({status:'complete'});
  const filename=path.resolve(__dirname,'../netlify/functions/stripe-webhook.js');
  const localRequire=createRequire(filename); const exports={};
  const session={id:'cs_test_late',payment_status:'paid',currency:'cad',amount_total:699,
    metadata:{userId:callerId,packageId:'minutes_15'},payment_intent:'pi_test'};
  vm.compileFunction(fs.readFileSync(filename,'utf8'),['exports','require','process','console'],{filename})(exports,
    name=>name==='./_shared/firebase-admin'?{Timestamp,firestore:()=>db}:
    name==='./_shared/stripe'?{packageFor:()=>({id:'minutes_15',seconds:900,amount:699,currency:'cad'}),
      stripeClient:()=>({webhooks:{constructEvent:()=>({type:'checkout.session.completed',data:{object:session}})}})}:localRequire(name),
    {env:{CONTEXT:'deploy-preview',STRIPE_WEBHOOK_SECRET:'whsec_mock'}},console);
  for(let retry=0;retry<2;retry++) assert.equal((await exports.handler({httpMethod:'POST',headers:{'stripe-signature':'mock'},body:'mock'})).statusCode,200);
  assert.equal((await db.collection('callWallets').doc(callerId).get()).exists,false);
  assert.equal((await db.collection('callPurchases').get()).size,1);
  assert.equal((await db.collection('callPurchases').doc(session.id).get()).data().status,'paid_account_deleted');
});


test("Storage denies deleted members and hides their photos from other members", async () => {
  const owner=environment.authenticatedContext(callerId,{email_verified:true}).storage();
  const other=environment.authenticatedContext(calleeId,{email_verified:true}).storage();
  const photo=`profilePhotos/${callerId}/deletion-test.jpg`;
  const otherPhoto=`profilePhotos/${calleeId}/deletion-test.jpg`;
  await assertSucceeds(owner.ref(photo).put(new Uint8Array([1,2,3]),{contentType:'image/jpeg'}));
  await assertSucceeds(other.ref(photo).getMetadata());
  await db.collection('accountDeletions').doc(callerId).set({status:'pending'});
  await assertFails(owner.ref(photo).getMetadata());
  await assertFails(owner.ref(photo).put(new Uint8Array([1]),{contentType:'image/jpeg'}));
  await assertFails(other.ref(photo).getMetadata());
  await assertSucceeds(other.ref(otherPhoto).put(new Uint8Array([1]),{contentType:'image/jpeg'}));
  await assertSucceeds(other.ref(otherPhoto).getMetadata());
});
