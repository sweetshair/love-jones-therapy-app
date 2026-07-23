import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
  updateProfile
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  limit,
  query,
  serverTimestamp,
  setDoc,
  where
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";
import {
  deleteObject,
  getBlob,
  getStorage,
  ref as storageRef,
  uploadBytes
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyAd8Fj3RRYXEju1z1ZfdW6351IGlN88Ono",
  authDomain: "love-jones-therapy-app.firebaseapp.com",
  projectId: "love-jones-therapy-app",
  storageBucket: "love-jones-therapy-app.firebasestorage.app",
  messagingSenderId: "551807483051",
  appId: "1:551807483051:web:65106d020f51c5a3b88bee"
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);
const storage = getStorage(firebaseApp);
const verificationSettings = {
  url: window.location.origin,
  handleCodeInApp: false
};

await setPersistence(auth, browserLocalPersistence);

function publicUser(user) {
  if (!user) return null;
  return {
    uid: user.uid,
    email: user.email || "",
    displayName: user.displayName || "",
    emailVerified: user.emailVerified
  };
}

function requireUser() {
  if (!auth.currentUser) throw new Error("You must sign in first.");
  return auth.currentUser;
}

async function signUp({ name, phone, email, password, consent }) {
  const credential = await createUserWithEmailAndPassword(auth, email, password);
  const user = credential.user;
  await updateProfile(user, { displayName: name });
  await setDoc(doc(db, "users", user.uid), {
    name,
    phone,
    email: user.email,
    consent: Boolean(consent),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  await sendEmailVerification(user, verificationSettings);
  return publicUser(user);
}

async function signIn(email, password) {
  const credential = await signInWithEmailAndPassword(auth, email, password);
  return publicUser(credential.user);
}

async function logOut() {
  await signOut(auth);
}

async function resetPassword(email) {
  await sendPasswordResetEmail(auth, email);
}

async function resendVerification() {
  const user = requireUser();
  if (user.emailVerified) return false;
  await sendEmailVerification(user, verificationSettings);
  return true;
}

async function getMyProfile() {
  const user = requireUser();
  const snapshot = await getDoc(doc(db, "users", user.uid));
  return snapshot.exists() ? snapshot.data() : null;
}

async function saveMyProfile({ name, phone, consent }) {
  const user = requireUser();
  if (name && name !== user.displayName) await updateProfile(user, { displayName: name });
  await setDoc(doc(db, "users", user.uid), {
    name,
    phone,
    email: user.email,
    consent: Boolean(consent),
    updatedAt: serverTimestamp()
  }, { merge: true });
}

async function saveQuizResult(result) {
  const user = requireUser();
  const payload = {
    ...result,
    createdAt: serverTimestamp()
  };
  await addDoc(collection(db, "users", user.uid, "results"), payload);
  await setDoc(doc(db, "users", user.uid), {
    relationshipType: result.primaryType,
    secondaryType: result.secondaryType,
    latestScores: result.scores,
    quizUpdatedAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  }, { merge: true });
}

async function saveDatingProfile(profile) {
  const user = requireUser();
  await setDoc(doc(db, "datingProfiles", user.uid), {
    ...profile,
    ownerId: user.uid,
    updatedAt: serverTimestamp()
  }, { merge: true });
}

async function getMyDatingProfile() {
  const user = requireUser();
  const snapshot = await getDoc(doc(db, "datingProfiles", user.uid));
  return snapshot.exists() ? snapshot.data() : null;
}

async function findDatingProfiles(relationshipTypes = []) {
  const user = requireUser();
  const profiles = [];
  const snapshot = await getDocs(query(
    collection(db, "datingProfiles"),
    where("active", "==", true),
    limit(80)
  ));
  snapshot.forEach(item => {
    const data = item.data();
    if (item.id !== user.uid && relationshipTypes.includes(data.relationshipType)) {
      profiles.push({ id: item.id, ...data });
    }
  });
  return profiles;
}

function photoExtension(contentType) {
  const extensions = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp"
  };
  return extensions[contentType] || null;
}

async function uploadProfilePhoto(file) {
  const user = requireUser();
  const extension = photoExtension(file.type);
  if (!extension) throw new Error("Choose a JPEG, PNG or WebP photo.");
  if (file.size >= 5 * 1024 * 1024) throw new Error("Each photo must be smaller than 5 MB.");
  const uniqueName = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}.${extension}`;
  const path = `profilePhotos/${user.uid}/${uniqueName}`;
  await uploadBytes(storageRef(storage, path), file, { contentType: file.type });
  return path;
}

async function loadProfilePhoto(path) {
  requireUser();
  const blob = await getBlob(storageRef(storage, path), 5 * 1024 * 1024);
  return URL.createObjectURL(blob);
}

async function deleteProfilePhoto(path) {
  const user = requireUser();
  const ownerPrefix = `profilePhotos/${user.uid}/`;
  if (!path.startsWith(ownerPrefix)) throw new Error("You can only delete your own photos.");
  await deleteObject(storageRef(storage, path));
}

window.ljtFirebase = {
  signUp,
  signIn,
  signOut: logOut,
  resetPassword,
  resendVerification,
  getMyProfile,
  saveMyProfile,
  saveQuizResult,
  saveDatingProfile,
  getMyDatingProfile,
  findDatingProfiles,
  uploadProfilePhoto,
  loadProfilePhoto,
  deleteProfilePhoto,
  currentUser: () => publicUser(auth.currentUser)
};

window.dispatchEvent(new CustomEvent("ljt-firebase-ready"));

onAuthStateChanged(auth, user => {
  window.dispatchEvent(new CustomEvent("ljt-auth-change", {
    detail: { user: publicUser(user) }
  }));
});
