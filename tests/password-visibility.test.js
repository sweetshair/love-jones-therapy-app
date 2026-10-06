const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

test("password fields include accessible show/hide controls", () => {
  assert.match(html, /id="passwordInput"[^>]*type="password"/);
  assert.match(html, /data-password-toggle="passwordInput"[^>]*aria-label="Show password"[^>]*aria-pressed="false"/);
  assert.match(html, /id="deletePassword"[^>]*type="password"/);
  assert.match(html, /data-password-toggle="deletePassword"[^>]*aria-label="Show password"[^>]*aria-pressed="false"/);
  assert.match(html, /input\.type = showing \? "password" : "text"/);
  assert.match(html, /Beta build UAT 67/);
});
