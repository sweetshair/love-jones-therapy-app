const { jsonResponse } = require("./_shared/http");
const { firestore, verifiedUser } = require("./_shared/firebase-admin");

exports.handler = async event => {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed." });
  try {
    const user = await verifiedUser(event);
    if (!user) return jsonResponse(401, { error: "Sign in with a verified account first." });
    const snapshot = await firestore().collection("callWallets").doc(user.uid).get();
    const wallet = snapshot.exists ? snapshot.data() : {};
    return jsonResponse(200, {
      balanceSeconds: Math.max(0, Number(wallet.balanceSeconds) || 0),
      purchasedSeconds: Math.max(0, Number(wallet.purchasedSeconds) || 0),
      spentSeconds: Math.max(0, Number(wallet.spentSeconds) || 0)
    });
  } catch (error) {
    console.error("Call wallet lookup failed:", error.message);
    return jsonResponse(503, { error: "The call-time balance is temporarily unavailable." });
  }
};
