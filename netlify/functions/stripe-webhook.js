const { jsonResponse } = require("./_shared/http");
const { Timestamp, firestore } = require("./_shared/firebase-admin");
const { packageFor, stripeClient } = require("./_shared/stripe");

async function creditCompletedCheckout(session) {
  if (session.payment_status !== "paid") return;
  const selected = packageFor(session.metadata?.packageId);
  const userId = String(session.metadata?.userId || session.client_reference_id || "");
  if (!selected || !userId) throw new Error("Checkout metadata is incomplete.");
  if (session.currency !== selected.currency || Number(session.amount_total) !== selected.amount) {
    throw new Error("Checkout package details do not match.");
  }

  const db = firestore();
  const purchaseRef = db.collection("callPurchases").doc(session.id);
  const walletRef = db.collection("callWallets").doc(userId);
  await db.runTransaction(async transaction => {
    const [purchaseSnapshot, walletSnapshot] = await Promise.all([
      transaction.get(purchaseRef),
      transaction.get(walletRef)
    ]);
    if (purchaseSnapshot.exists) return;
    const wallet = walletSnapshot.exists ? walletSnapshot.data() : {};
    const balanceSeconds = Math.max(0, Number(wallet.balanceSeconds) || 0) + selected.seconds;
    transaction.set(walletRef, {
      ownerId: userId,
      balanceSeconds,
      purchasedSeconds: Math.max(0, Number(wallet.purchasedSeconds) || 0) + selected.seconds,
      spentSeconds: Math.max(0, Number(wallet.spentSeconds) || 0),
      updatedAt: Timestamp.now()
    }, { merge: true });
    transaction.create(purchaseRef, {
      ownerId: userId,
      stripeSessionId: session.id,
      stripePaymentIntentId: String(session.payment_intent || ""),
      packageId: selected.id,
      seconds: selected.seconds,
      amount: selected.amount,
      currency: selected.currency,
      status: "paid",
      createdAt: Timestamp.now()
    });
  });
}

exports.handler = async event => {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed." });
  try {
    const signature = String(event.headers?.["stripe-signature"] || "");
    const webhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || "").trim();
    if (!signature || !webhookSecret.startsWith("whsec_")) {
      return jsonResponse(400, { error: "Stripe webhook verification is not configured." });
    }
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64").toString("utf8")
      : event.body || "";
    const stripeEvent = stripeClient().webhooks.constructEvent(rawBody, signature, webhookSecret);
    if (stripeEvent.type === "checkout.session.completed") {
      await creditCompletedCheckout(stripeEvent.data.object);
    }
    return jsonResponse(200, { received: true });
  } catch (error) {
    console.error("Stripe webhook failed:", error.message);
    return jsonResponse(400, { error: "Webhook verification failed." });
  }
};
