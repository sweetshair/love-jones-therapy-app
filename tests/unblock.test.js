const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require("node:path").join(__dirname, "../firebase-client.js"), "utf8");
function setup() {
  const removed = [];
  const context = {
    requireUser: () => ({ uid: "me" }), db: {},
    doc: (_db, collection, id) => collection + "/" + id,
    deleteDoc: async path => removed.push(path)
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf("async function unblockMember("), source.indexOf("async function reportMember(")), context);
  return { context, removed };
}
test("unblock removes only the signed-in member's outgoing block", async () => {
  const { context, removed } = setup();
  await context.unblockMember("other");
  assert.deepEqual(removed, ["blocks/me_other"]);
});
test("invalid unblock targets never write to Firestore", async () => {
  const { context, removed } = setup();
  for (const target of ["", "me", "other/path"]) await assert.rejects(context.unblockMember(target));
  assert.deepEqual(removed, []);
});
