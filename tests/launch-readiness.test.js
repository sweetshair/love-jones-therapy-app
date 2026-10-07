const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

test("live site shows the real support contact and public pricing information", () => {
  assert.doesNotMatch(html, /support@firstoptiondating\.com/);
  assert.match(html, /firstoptiondating@gmail\.com/);
  assert.match(html, /data-policy="pricing">Pricing & Payments<\/a>/);
  assert.match(html, /15 minutes — \$6\.99 CAD/);
  assert.match(html, /30 minutes — \$11\.99 CAD/);
  assert.match(html, /60 minutes — \$19\.99 CAD/);
});

test("real payment checkout stays disabled on production while beta keeps test checkout", () => {
  assert.match(html, /const IS_DEPLOY_PREVIEW = window\.location\.hostname\.startsWith\("deploy-preview-"\)/);
  assert.match(html, /Payments activating/);
  assert.match(html, /Beta checkout uses test payments only/);
  assert.match(html, /if\(!IS_DEPLOY_PREVIEW\)\{\s*showToast\("Online payments are being activated\. No charge was attempted\."\)/);
});

test("production-facing build label is live while preview retains UAT 80", () => {
  assert.match(html, /id="appBuildLabel">First Option Dating • Live<\/span>/);
  assert.match(html, /Beta build UAT 80/);
});
