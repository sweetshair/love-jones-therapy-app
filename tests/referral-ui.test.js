const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const client = fs.readFileSync(path.join(__dirname, "..", "firebase-client.js"), "utf8");
const wallet = fs.readFileSync(path.join(__dirname, "..", "netlify", "functions", "call-wallet.js"), "utf8");
const paid = fs.readFileSync(path.join(__dirname, "..", "netlify", "functions", "paid-call-session.js"), "utf8");

test("referral UI uses the approved three-minute Give 3 Get 3 reward", () => {
  assert.match(html, /Give 3 minutes • Get 3 minutes/);
  assert.match(html, /both of you for 3 bonus call minutes/);
  assert.match(html, /id="referralBtn">Refer Friends<\/button>/);
  assert.match(html, /Referral code \(optional\)/);
});

test("signup captures referral links and registers the claim server-side", () => {
  assert.match(html, /searchParams\.get\("ref"\)/);
  assert.match(client, /action:"register"/);
  assert.match(client, /referralCodeForUid/);
});

test("referral bonus is combined into call balance and metered before purchased time", () => {
  assert.match(wallet, /referralBonusSecondsAvailable/);
  assert.match(paid, /referralBonusChargedSeconds = Math\.min\(chargedSeconds, referralBonusSecondsAvailable\)/);
  assert.match(html, /Bonus time is used first/);
});
