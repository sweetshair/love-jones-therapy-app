const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const client = fs.readFileSync(path.join(__dirname, "..", "firebase-client.js"), "utf8");

test("matching navigation includes a free Likes You view", () => {
  assert.match(html, /id="likesYouTabBtn"[^>]*>Likes You<\/button>/);
  assert.match(html, /data-likes-you-action="like"/);
  assert.match(html, />Like Back<\/button>/);
  assert.match(html, /data-likes-you-action="pass"/);
  assert.match(html, /No new Likes yet/);
});

test("Likes You uses the protected endpoint and existing swipe action", () => {
  assert.match(client, /async function getLikesYou\(\)/);
  assert.match(client, /fetch\("\/.netlify\/functions\/likes-you"/);
  assert.match(html, /window\.ljtFirebase\.recordSwipe\(profile, action === "like" \? "like" : "pass"\)/);
});
