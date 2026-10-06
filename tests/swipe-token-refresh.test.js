const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const client = fs.readFileSync(path.join(__dirname, "..", "firebase-client.js"), "utf8");

test("recordSwipe refreshes the Firebase ID token before calling the protected swipe endpoint", () => {
  const start = client.indexOf("async function recordSwipe");
  const end = client.indexOf("async function getMutualMatches", start);
  assert.ok(start >= 0 && end > start, "recordSwipe function should exist");
  const body = client.slice(start, end);
  const refresh = body.indexOf("await getIdToken(user, true)");
  const request = body.indexOf('fetch("/.netlify/functions/record-swipe"');
  assert.ok(refresh >= 0, "recordSwipe should force-refresh the ID token");
  assert.ok(request > refresh, "token refresh must happen before the swipe endpoint is called");
  assert.match(body, /requireUser\(\) !== user/);
  assert.doesNotMatch(body, /setDoc\(swipeReference/);
});
