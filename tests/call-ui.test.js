const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.resolve(__dirname, "../index.html"), "utf8");
function functionSource(name, nextName) {
  const start = html.search(new RegExp(`  (?:async )?function ${name}\\(`));
  const end = html.indexOf(`\n  ${nextName}`, start);
  assert.ok(start >= 0 && end > start);
  return html.slice(start, end);
}

test("a rejected outgoing attempt preserves the incoming call and releases media", async () => {
  const incoming = { id: "incoming", status: "ringing", callerId: "other", calleeId: "me" };
  let cleaned = false;
  const state = { activeConversation: { matchId: "match", memberId: "other" }, authUser: { uid: "me" } };
  const sandbox = {
    state, FREE_CALL_SECONDS: 180,
    callIsOpen: () => false, renderMessages() {}, getFreeCallReconnect: () => null,
    pauseMoodForCall() {}, getVerifiedCallMedia: async () => ({}), getCallIceServers: async () => [],
    createCallPeer: () => ({ createOffer: async () => ({}), setLocalDescription: async () => {} }),
    cleanupCallMedia: () => { cleaned = true; state.activeCallId = ""; }, showToast() {},
    scheduleRingTimeout() {},
    window: { ljtFirebase: {
      getFreeCallAllowance: async () => ({ allowed: true }),
      createCallSignal: async () => { state.call = incoming; throw new Error("A call is already in progress."); }
    } }
  };
  vm.createContext(sandbox);
  vm.runInContext(functionSource("startOutgoingCall", "async function answerIncomingCall"), sandbox);
  await sandbox.startOutgoingCall("audio");
  assert.equal(state.call, incoming);
  assert.equal(state.callBusy, false);
  assert.equal(cleaned, true);
});

test("a global answer waits for pending outgoing setup to finish", () => {
  let explanation = "";
  let changedConversation = false;
  const sandbox = { state: { callBusy: true }, showToast: message => { explanation = message; },
    connectionMemberDetails: () => ({}), stopCallWatch: () => { changedConversation = true; },
    stopMessageWatch() {}, closeIncomingCallAlert() {}, renderMessages() {}, answerIncomingCall() {}
  };
  vm.createContext(sandbox);
  vm.runInContext(functionSource("openIncomingCallConversation", "async function declineGlobalIncomingCall"), sandbox);
  sandbox.openIncomingCallConversation({}, {}, true);
  assert.equal(changedConversation, false);
  assert.match(explanation, /wait/i);
});

test("failure after reservation closes our call and releases media", async () => {
  let closed;
  let cleaned = false;
  const state = { activeConversation: { matchId: "match", memberId: "other" }, authUser: { uid: "me" } };
  const sandbox = {
    state, FREE_CALL_SECONDS: 180,
    callIsOpen: () => false, renderMessages() {}, getFreeCallReconnect: () => null,
    pauseMoodForCall() {}, getVerifiedCallMedia: async () => ({}), getCallIceServers: async () => [],
    createCallPeer: () => ({ createOffer: async () => ({}), setLocalDescription: async () => {} }),
    cleanupCallMedia: () => { cleaned = true; state.activeCallId = ""; }, showToast() {},
    scheduleRingTimeout() {}, watchRemoteCallCandidates() {},
    flushLocalCallCandidates: async () => { throw new Error("Connection failed"); },
    window: { ljtFirebase: {
      getFreeCallAllowance: async () => ({ allowed: true }), createCallSignal: async () => "our-call",
      updateCallStatus: async (...args) => { closed = args; }
    } }
  };
  vm.createContext(sandbox);
  vm.runInContext(functionSource("startOutgoingCall", "async function answerIncomingCall"), sandbox);
  await sandbox.startOutgoingCall("audio");
  assert.deepEqual(closed, ["match", "our-call", "failed"]);
  assert.equal(state.call, null);
  assert.equal(state.callBusy, false);
  assert.equal(cleaned, true);
});
