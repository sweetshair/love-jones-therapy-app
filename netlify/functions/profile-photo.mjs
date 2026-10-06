import admin from "./_shared/firebase-admin.js";
import photo from "./_shared/profile-photo.js";
import { getStorage } from "firebase-admin/storage";

export default photo.createPhotoHandler({
  authenticatedUser: admin.authenticatedUser,
  firestore: admin.firestore,
  bucket: () => getStorage(admin.firebaseApp()).bucket("love-jones-therapy-app.firebasestorage.app")
});
