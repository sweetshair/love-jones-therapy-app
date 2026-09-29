const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("English is sent to translation rather than treated as disabled", () => {
  const client = fs.readFileSync(path.resolve(__dirname, "../firebase-client.js"), "utf8");
  const endpoint = fs.readFileSync(path.resolve(__dirname, "../netlify/functions/translate-message.js"), "utf8");
  assert.doesNotMatch(client, /target\s*===\s*["']en["']/);
  assert.doesNotMatch(endpoint, /target\s*===\s*["']en["']/);
  assert.match(endpoint, /messageTranslationCache/);
});

test("translation fan-out is capped at three workers", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../index.html"), "utf8");
  assert.match(html, /Math\.min\(3, queue\.length\)/);
  assert.doesNotMatch(html, /preferredLanguage === ["']en["'] \|\| !state\.authUser/);
});
