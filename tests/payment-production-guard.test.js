const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

function compileHandler(relativePath, env, spies = {}) {
  const filename = path.resolve(__dirname, "..", relativePath);
  const localRequire = createRequire(filename);
  const exportsObject = {};
  vm.compileFunction(fs.readFileSync(filename, "utf8"), ["exports", "require", "process", "console"], { filename })(
    exportsObject,
    name => {
      if (name === "./_shared/http") {
        return {
          jsonResponse: (statusCode, body) => ({ statusCode, body: JSON.stringify(body) }),
          parseJsonBody: () => ({ packageId: "minutes_15" })
        };
      }
      if (name === "./_shared/firebase-admin") {
        return {
          verifiedUser: async () => {
            spies.verifiedUserCalled = true;
            return { uid: "member", email: "member@example.test" };
          },
          Timestamp: { now: () => ({}) },
          firestore: () => {
            spies.firestoreCalled = true;
            throw new Error("Firestore should not be reached.");
          }
        };
      }
      if (name === "./_shared/stripe") {
        return {
          packageFor: () => ({ id:"minutes_15", seconds:900, amount:699, currency:"cad" }),
          stripeClient: () => {
            spies.stripeCalled = true;
            throw new Error("Stripe should not be reached.");
          }
        };
      }
      return localRequire(name);
    },
    { env },
    console
  );
  return exportsObject.handler;
}

test("production checkout endpoint is disabled before authentication or Stripe", async () => {
  const spies = {};
  const handler = compileHandler("netlify/functions/create-checkout-session.js", { CONTEXT:"production" }, spies);
  const response = await handler({ httpMethod:"POST", headers:{} });
  assert.equal(response.statusCode, 503);
  assert.match(response.body, /being activated/);
  assert.equal(spies.verifiedUserCalled, undefined);
  assert.equal(spies.stripeCalled, undefined);
});

test("production legacy Stripe webhook acknowledges without crediting wallets", async () => {
  const spies = {};
  const handler = compileHandler("netlify/functions/stripe-webhook.js", { CONTEXT:"production" }, spies);
  const response = await handler({ httpMethod:"POST", headers:{}, body:"ignored" });
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.disabled, true);
  assert.equal(spies.firestoreCalled, undefined);
  assert.equal(spies.stripeCalled, undefined);
});
