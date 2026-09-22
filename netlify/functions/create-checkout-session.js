const { jsonResponse, parseJsonBody } = require("./_shared/http");
const { verifiedUser } = require("./_shared/firebase-admin");
const { packageFor, stripeClient } = require("./_shared/stripe");

function safeOrigin(event) {
  const value = String(event.headers?.origin || event.headers?.Origin || "").trim();
  let origin;
  try {
    origin = new URL(value);
  } catch (error) {
    throw new Error("The checkout return address is invalid.");
  }
  const host = origin.hostname.toLowerCase();
  const allowed = origin.protocol === "https:" && (
    host === "firstoptiondating.com"
    || host === "www.firstoptiondating.com"
    || host === "firstoptiondating.ca"
    || host === "www.firstoptiondating.ca"
    || host.endsWith(".netlify.app")
  );
  if (!allowed) throw new Error("The checkout return address is not allowed.");
  return origin.origin;
}

exports.handler = async event => {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed." });
  try {
    const user = await verifiedUser(event);
    if (!user) return jsonResponse(401, { error: "Sign in with a verified account first." });
    const body = parseJsonBody(event);
    const selected = packageFor(body.packageId);
    if (!selected) return jsonResponse(400, { error: "Choose an available call-time package." });
    const origin = safeOrigin(event);
    const session = await stripeClient().checkout.sessions.create({
      mode: "payment",
      customer_email: user.email || undefined,
      client_reference_id: user.uid,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: selected.currency,
          unit_amount: selected.amount,
          product_data: {
            name: `First Option Dating ${selected.label}`,
            description: "Purchased voice and video call time"
          }
        }
      }],
      metadata: {
        userId: user.uid,
        packageId: selected.id,
        seconds: String(selected.seconds)
      },
      payment_intent_data: {
        metadata: {
          userId: user.uid,
          packageId: selected.id,
          seconds: String(selected.seconds)
        }
      },
      success_url: `${origin}/?stripe=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?stripe=cancelled`
    });
    return jsonResponse(200, { checkoutUrl: session.url });
  } catch (error) {
    console.error("Checkout session failed:", error.message);
    return jsonResponse(503, { error: error.message || "Checkout is temporarily unavailable." });
  }
};
