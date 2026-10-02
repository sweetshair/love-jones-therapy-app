const { cert, getApps, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { FieldValue, Timestamp, getFirestore } = require("firebase-admin/firestore");

function firebaseApp() {
  if (getApps().length) return getApps()[0];
  const raw = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim();
  if (!raw) throw new Error("Firebase service credentials are not configured.");
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch (error) {
    throw new Error("Firebase service credentials are invalid.");
  }
  if (serviceAccount.private_key) {
    serviceAccount.private_key = String(serviceAccount.private_key).replace(/\\n/g, "\n");
  }
  return initializeApp({
    credential: cert(serviceAccount),
    projectId: serviceAccount.project_id || "love-jones-therapy-app"
  });
}

async function verifiedUser(event) {
  const authorization = String(event.headers?.authorization || event.headers?.Authorization || "");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const decoded = await getAuth(firebaseApp()).verifyIdToken(match[1], true);
  return decoded.email_verified ? decoded : null;
}

function firestore() {
  return getFirestore(firebaseApp());
}

module.exports = { FieldValue, Timestamp, firestore, verifiedUser };
