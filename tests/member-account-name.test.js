const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const client = fs.readFileSync(path.join(__dirname, "..", "firebase-client.js"), "utf8");

test("member account collects structured private names and a separate display name", () => {
  assert.match(html, /id="firstNameInput"[^>]*autocomplete="given-name"/);
  assert.match(html, /id="lastNameInput"[^>]*autocomplete="family-name"/);
  assert.match(html, /id="accountDisplayNameInput"[^>]*maxlength="30"/);
  assert.match(html, /Your first and last name stay private/);
  assert.match(html, /firstName: state\.userFirstName/);
  assert.match(html, /lastName: state\.userLastName/);
  assert.match(html, /displayName: state\.userDisplayName/);
});

test("account storage keeps full name private and Firebase Auth uses display name", () => {
  assert.match(client, /firstName: cleanFirstName/);
  assert.match(client, /lastName: cleanLastName/);
  assert.match(client, /displayName: cleanDisplayName/);
  assert.match(client, /updateProfile\(user, \{ displayName: cleanDisplayName \}\)/);
  assert.match(client, /name: fullName/);
});
