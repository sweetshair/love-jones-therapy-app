const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require("node:path").join(__dirname, "../firebase-client.js"), "utf8");
const start = source.indexOf("async function uploadPreparedProfilePhoto(");
const end = source.indexOf("async function commitPendingProfilePhotos(", start);
function setup(overrides = {}) {
  const user = { uid: "owner", emailVerified: true };
  const events = [];
  const sandbox = {
    user, events, storage: {},
    requireUser: () => user,
    photoExtension: () => "jpg",
    prepareProfilePhoto: async file => file,
    saveDraftPhoto: async () => { events.push("draft"); return "draftPhoto:local"; },
    getIdToken: async (actual, force) => {
      assert.equal(actual, user); assert.equal(force, true); events.push("refresh");
    },
    storageRef: (_storage, path) => path,
    uploadBytes: async path => { events.push("upload"); assert.match(path, /^profilePhotos\/owner\//); },
    ...overrides
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(start, end), sandbox);
  return sandbox;
}
const photo = { type: "image/jpeg", size: 1024 };
test("verified photo upload refreshes credentials before Storage", async () => {
  const s = setup();
  await s.uploadProfilePhoto(photo);
  assert.deepEqual(s.events, ["refresh", "upload"]);
});
test("unverified photos remain local drafts", async () => {
  const s = setup(); s.user.emailVerified = false;
  assert.equal(await s.uploadProfilePhoto(photo), "draftPhoto:local");
  assert.deepEqual(s.events, ["draft"]);
});
test("failed credential refresh never attempts an upload", async () => {
  const s = setup({ getIdToken: async () => { throw new Error("offline"); } });
  await assert.rejects(s.uploadProfilePhoto(photo), /offline/);
  assert.deepEqual(s.events, []);
});
test("switching accounts during refresh stops the upload", async () => {
  const s = setup();
  s.getIdToken = async () => { s.requireUser = () => ({ uid: "other" }); };
  await assert.rejects(s.uploadProfilePhoto(photo), /account changed/);
  assert.deepEqual(s.events, []);
});
test("saved draft upload uses the same credential refresh", async () => {
  const s = setup();
  await s.uploadPreparedProfilePhoto(s.user, photo);
  assert.deepEqual(s.events, ["refresh", "upload"]);
});
