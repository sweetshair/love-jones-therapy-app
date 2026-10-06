const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const discover = fs.readFileSync(path.join(__dirname, "..", "netlify", "functions", "discover-profiles.js"), "utf8");

test("Discover People requires an active published dating profile before swiping", () => {
  assert.match(html, /savedProfile\.active === true/);
  assert.match(html, /state\.datingProfile\.active === true/);
  assert.match(html, /Turn on “Show my dating profile to signed-in members”/);
});

test("server discovery enforces member eligibility instead of bypassing Firestore swipe gates", () => {
  assert.match(discover, /accountDeletions/);
  assert.match(discover, /accountSuspensions/);
  assert.match(discover, /ageConfirmed !== true/);
  assert.match(discover, /own\.active !== true/);
  assert.match(discover, /Publish your completed dating profile before using Discover People/);
});
