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
  onSnapshot,
  orderBy,
  query,
  runTransaction,
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
    ageConfirmed: true,
    termsAcceptedAt: serverTimestamp(),
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
  if (profile.termsAccepted === true) {
    await setDoc(doc(db, "users", user.uid), {
      ageConfirmed: true,
      termsAcceptedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }, { merge: true });
  }
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
  const seen = new Set();
  const blocked = new Set();
  const [outgoingBlocks, incomingBlocks] = await Promise.all([
    getDocs(query(
      collection(db, "blocks"),
      where("blockerId", "==", user.uid),
      limit(250)
    )),
    getDocs(query(
      collection(db, "blocks"),
      where("blockedId", "==", user.uid),
      limit(250)
    ))
  ]);
  outgoingBlocks.forEach(item => blocked.add(item.data().blockedId));
  incomingBlocks.forEach(item => blocked.add(item.data().blockerId));
  const seenSnapshot = await getDocs(query(
    collection(db, "swipes"),
    where("fromId", "==", user.uid),
    limit(250)
  ));
  seenSnapshot.forEach(item => seen.add(item.data().toId));
  const snapshot = await getDocs(query(
    collection(db, "datingProfiles"),
    where("active", "==", true),
    limit(80)
  ));
  snapshot.forEach(item => {
    const data = item.data();
    if (
      item.id !== user.uid
      && !seen.has(item.id)
      && !blocked.has(item.id)
      && relationshipTypes.includes(data.relationshipType)
    ) {
      profiles.push({ id: item.id, ...data });
    }
  });
  return profiles;
}

function matchIdFor(firstId, secondId) {
  return [firstId, secondId].sort().join("_");
}

function publicProfileSnapshot(profile = {}) {
  return {
    displayName: String(profile.displayName || "Member").slice(0, 30),
    age: Number(profile.age) || null,
    city: String(profile.city || "").slice(0, 60),
    region: String(profile.region || "").slice(0, 60),
    country: String(profile.country || "").slice(0, 60),
    relationshipType: String(profile.relationshipType || "").slice(0, 10),
    photoPath: Array.isArray(profile.photoPaths) ? String(profile.photoPaths[0] || "") : ""
  };
}

async function recordSwipe(targetProfile, decision) {
  const user = requireUser();
  const targetId = String(targetProfile?.id || "");
  if (!targetId || targetId === user.uid) throw new Error("That profile is unavailable.");
  if (!["like", "pass"].includes(decision)) throw new Error("Choose Like or Pass.");

  const id = `${user.uid}_${targetId}`;
  const swipeReference = doc(db, "swipes", id);
  const existingSwipe = await getDoc(swipeReference);
  if (existingSwipe.exists()) {
    await setDoc(swipeReference, {
      decision,
      updatedAt: serverTimestamp()
    }, { merge: true });
  } else {
    await setDoc(swipeReference, {
      fromId: user.uid,
      toId: targetId,
      decision,
      updatedAt: serverTimestamp(),
      createdAt: serverTimestamp()
    });
  }

  if (decision !== "like") return { matched: false, matchId: "" };

  const reverse = await getDoc(doc(db, "swipes", `${targetId}_${user.uid}`));
  if (!reverse.exists() || reverse.data().decision !== "like") {
    return { matched: false, matchId: "" };
  }

  const ownProfileSnapshot = await getDoc(doc(db, "datingProfiles", user.uid));
  if (!ownProfileSnapshot.exists()) throw new Error("Complete your dating profile first.");
  const memberIds = [user.uid, targetId].sort();
  const matchId = matchIdFor(user.uid, targetId);
  const matchReference = doc(db, "matches", matchId);
  const existingMatch = await getDoc(matchReference);
  if (!existingMatch.exists()) {
    await setDoc(matchReference, {
      memberIds,
      status: "active",
      profileSnapshots: {
        [user.uid]: publicProfileSnapshot(ownProfileSnapshot.data()),
        [targetId]: publicProfileSnapshot(targetProfile)
      },
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  }
  return { matched: true, matchId };
}

async function getMutualMatches() {
  const user = requireUser();
  const matches = [];
  const snapshot = await getDocs(query(
    collection(db, "matches"),
    where("memberIds", "array-contains", user.uid),
    limit(80)
  ));
  snapshot.forEach(item => {
    const data = item.data();
    if (data.status === "active") matches.push({ id: item.id, ...data });
  });
  return matches;
}

function watchMessages(matchId, onMessages, onError) {
  requireUser();
  return onSnapshot(query(
    collection(db, "matches", matchId, "messages"),
    orderBy("createdAt", "asc"),
    limit(150)
  ), snapshot => {
    onMessages(snapshot.docs.map(item => ({ id: item.id, ...item.data() })));
  }, onError);
}

async function sendMessage(matchId, text) {
  const user = requireUser();
  const cleanText = String(text || "").trim();
  if (!cleanText) throw new Error("Write a message first.");
  if (cleanText.length > 1000) throw new Error("Messages must be 1,000 characters or fewer.");
  await addDoc(collection(db, "matches", matchId, "messages"), {
    senderId: user.uid,
    text: cleanText,
    createdAt: serverTimestamp()
  });
}

function safeSessionDescription(description) {
  const type = String(description?.type || "");
  const sdp = String(description?.sdp || "");
  if (!["offer", "answer"].includes(type) || !sdp) {
    throw new Error("The call connection information is incomplete.");
  }
  return { type, sdp };
}

function watchLatestCall(matchId, onCall, onError) {
  requireUser();
  return onSnapshot(query(
    collection(db, "matches", matchId, "calls"),
    orderBy("createdAt", "desc"),
    limit(1)
  ), snapshot => {
    const item = snapshot.docs[0];
    onCall(item ? { id: item.id, ...item.data() } : null);
  }, onError);
}

async function createCallSignal(matchId, calleeId, mode, offer) {
  const user = requireUser();
  if (!matchId || !calleeId || calleeId === user.uid) throw new Error("That member cannot be called.");
  if (!["audio", "video"].includes(mode)) throw new Error("Choose a voice or video call.");
  const callReference = doc(collection(db, "matches", matchId, "calls"));
  await setDoc(callReference, {
    callerId: user.uid,
    calleeId,
    mode,
    status: "ringing",
    offer: safeSessionDescription(offer),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  return callReference.id;
}

async function answerCallSignal(matchId, callId, answer) {
  requireUser();
  await setDoc(doc(db, "matches", matchId, "calls", callId), {
    answer: safeSessionDescription(answer),
    status: "active",
    answeredAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  }, { merge: true });
}

async function updateCallStatus(matchId, callId, status) {
  requireUser();
  if (!["declined", "ended", "failed"].includes(status)) throw new Error("That call status is not supported.");
  await setDoc(doc(db, "matches", matchId, "calls", callId), {
    status,
    endedAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  }, { merge: true });
}

async function expireCallSignal(matchId, callId) {
  requireUser();
  const callRef = doc(db, "matches", matchId, "calls", callId);
  return runTransaction(db, async transaction => {
    const snapshot = await transaction.get(callRef);
    if (!snapshot.exists()) return false;
    const call = snapshot.data();
    if (call.status !== "ringing") return false;
    const createdAt = call.createdAt?.toMillis?.();
    if (createdAt && Date.now() < createdAt + 20000) return false;
    transaction.update(callRef, {
      status: "missed",
      endedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    return true;
  });
}

async function addCallCandidate(matchId, callId, role, candidate) {
  const user = requireUser();
  if (!["caller", "callee"].includes(role)) throw new Error("The call role is invalid.");
  const payload = candidate?.toJSON ? candidate.toJSON() : candidate;
  if (!payload?.candidate) return;
  await addDoc(collection(db, "matches", matchId, "calls", callId, `${role}Candidates`), {
    ownerId: user.uid,
    candidate: String(payload.candidate),
    sdpMid: payload.sdpMid == null ? null : String(payload.sdpMid),
    sdpMLineIndex: payload.sdpMLineIndex == null ? null : Number(payload.sdpMLineIndex),
    createdAt: serverTimestamp()
  });
}

function watchCallCandidates(matchId, callId, role, onCandidate, onError) {
  requireUser();
  if (!["caller", "callee"].includes(role)) throw new Error("The call role is invalid.");
  return onSnapshot(
    collection(db, "matches", matchId, "calls", callId, `${role}Candidates`),
    snapshot => {
      snapshot.docChanges().forEach(change => {
        if (change.type === "added") onCandidate({ id: change.doc.id, ...change.doc.data() });
      });
    },
    onError
  );
}

async function unmatch(matchId) {
  const user = requireUser();
  await setDoc(doc(db, "matches", matchId), {
    status: "closed",
    closedBy: user.uid,
    updatedAt: serverTimestamp()
  }, { merge: true });
}

async function blockMember(targetId, matchId = "") {
  const user = requireUser();
  if (!targetId || targetId === user.uid) throw new Error("That member cannot be blocked.");
  await setDoc(doc(db, "blocks", `${user.uid}_${targetId}`), {
    blockerId: user.uid,
    blockedId: targetId,
    createdAt: serverTimestamp()
  });
  if (matchId) await unmatch(matchId);
}

async function reportMember({ targetId, reason, details = "", matchId = "" }) {
  const user = requireUser();
  const allowedReasons = ["Fake profile", "Harassment", "Inappropriate content", "Underage concern", "Spam or scam", "Other"];
  if (!targetId || targetId === user.uid) throw new Error("That member cannot be reported.");
  if (!allowedReasons.includes(reason)) throw new Error("Choose a report reason.");
  await addDoc(collection(db, "reports"), {
    reporterId: user.uid,
    targetId,
    matchId,
    reason,
    details: String(details || "").trim().slice(0, 1000),
    status: "new",
    createdAt: serverTimestamp()
  });
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
  recordSwipe,
  getMutualMatches,
  watchMessages,
  sendMessage,
  watchLatestCall,
  createCallSignal,
  answerCallSignal,
  updateCallStatus,
  expireCallSignal,
  addCallCandidate,
  watchCallCandidates,
  unmatch,
  blockMember,
  reportMember,
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
