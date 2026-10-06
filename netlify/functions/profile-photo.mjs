import firebaseAdmin from "firebase-admin";
import photo from "./_shared/profile-photo.js";

function firebaseApp() {
  if (firebaseAdmin.apps?.length) return firebaseAdmin.apps[0];
  const raw = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim();
  if (!raw) throw new Error("Firebase service credentials are not configured.");
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch {
    throw new Error("Firebase service credentials are invalid.");
  }
  if (serviceAccount.private_key) {
    serviceAccount.private_key = String(serviceAccount.private_key).replace(/\\n/g, "\n");
  }
  return firebaseAdmin.initializeApp({
    credential: firebaseAdmin.credential.cert(serviceAccount),
    projectId: serviceAccount.project_id || "love-jones-therapy-app"
  });
}

async function authenticatedUser(event, checkRevoked = true) {
  const authorization = String(event.headers?.authorization || event.headers?.Authorization || "");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  return firebaseAdmin.auth(firebaseApp()).verifyIdToken(match[1], checkRevoked);
}

export default photo.createPhotoHandler({
  authenticatedUser,
  firestore: () => firebaseAdmin.firestore(firebaseApp()),
  bucket: () => firebaseAdmin.storage(firebaseApp()).bucket("love-jones-therapy-app.firebasestorage.app")
});
