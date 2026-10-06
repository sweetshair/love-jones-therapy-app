const Stripe = require("stripe");

const CALL_PACKAGES = Object.freeze({
  minutes_15: { id: "minutes_15", minutes: 15, seconds: 900, amount: 699, currency: "cad", label: "15 minutes" },
  minutes_30: { id: "minutes_30", minutes: 30, seconds: 1800, amount: 1199, currency: "cad", label: "30 minutes" },
  minutes_60: { id: "minutes_60", minutes: 60, seconds: 3600, amount: 1999, currency: "cad", label: "60 minutes" }
});

function stripeClient() {
  const secretKey = String(process.env.STRIPE_SECRET_KEY || "").trim();
  if (!secretKey.startsWith("sk_test_")) {
    throw new Error("Stripe test mode is not configured.");
  }
  return new Stripe(secretKey, { maxNetworkRetries: 2 });
}

function packageFor(packageId) {
  return CALL_PACKAGES[String(packageId || "")] || null;
}

module.exports = { CALL_PACKAGES, packageFor, stripeClient };
