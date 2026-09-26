import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  getAuth,
  getIdToken,
  onAuthStateChanged,
  reload,
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
auth.languageCode = "en";
const FREE_CALL_PROGRAM_START_MS = Date.parse("2026-09-22T00:00:00.000Z");

const authPersistenceReady = Promise.race([
  setPersistence(auth, browserLocalPersistence),
  new Promise(resolve => setTimeout(resolve, 4000))
]).catch(() => undefined);

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

async function deliverVerificationEmail(user) {
  try {
    await sendEmailVerification(user, verificationSettings);
  } catch (error) {
    if (error?.code !== "auth/unauthorized-continue-uri") throw error;
    await sendEmailVerification(user);
  }
  return user.email || "your email address";
}

async function getCurrentUserIdToken() {
  return getIdToken(requireUser());
}

async function signUp({ name, phone, email, password, consent }) {
  await authPersistenceReady;
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
  let verificationEmailSent = true;
  let verificationEmailError = "";
  try {
    await deliverVerificationEmail(user);
  } catch (error) {
    verificationEmailSent = false;
    verificationEmailError = error?.code || error?.message || "verification-email-failed";
  }
  return { ...publicUser(user), verificationEmailSent, verificationEmailError };
}

async function signIn(email, password) {
  await authPersistenceReady;
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
  return deliverVerificationEmail(user);
}

async function refreshVerification() {
  const user = requireUser();
  await reload(user);
  await getIdToken(user, true);
  return publicUser(user);
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
  const outgoingDecisions = new Map();
  const incomingLikes = new Set();
  const activeProfileIds = new Set();
  const blocked = new Set();
  const [outgoingBlocks, incomingBlocks, outgoingSwipes, incomingSwipes] = await Promise.all([
    getDocs(query(
      collection(db, "blocks"),
      where("blockerId", "==", user.uid),
      limit(250)
    )),
    getDocs(query(
      collection(db, "blocks"),
      where("blockedId", "==", user.uid),
      limit(250)
    )),
    getDocs(query(
      collection(db, "swipes"),
      where("fromId", "==", user.uid),
      limit(250)
    )),
    getDocs(query(
      collection(db, "swipes"),
      where("toId", "==", user.uid),
      limit(250)
    ))
  ]);
  outgoingBlocks.forEach(item => blocked.add(item.data().blockedId));
  incomingBlocks.forEach(item => blocked.add(item.data().blockerId));
  outgoingSwipes.forEach(item => {
    const data = item.data();
    outgoingDecisions.set(data.toId, data.decision);
  });
  incomingSwipes.forEach(item => {
    const data = item.data();
    if (data.decision === "like") incomingLikes.add(data.fromId);
  });
  const snapshot = await getDocs(query(
    collection(db, "datingProfiles"),
    where("active", "==", true)
  ));
  snapshot.forEach(item => {
    const data = item.data();
    activeProfileIds.add(item.id);
    const outgoingDecision = outgoingDecisions.get(item.id);
    const likedYou = incomingLikes.has(item.id);
    if (
      item.id !== user.uid
      && (!outgoingDecision || likedYou)
      && !blocked.has(item.id)
      && (likedYou || !relationshipTypes.length || relationshipTypes.includes(data.relationshipType))
    ) {
      profiles.push({ id: item.id, ...data, likedYou });
    }
  });
  return {
    profiles,
    status: {
      incomingLikes: incomingLikes.size,
      visibleIncomingLikes: profiles.filter(profile => profile.likedYou).length,
      unavailableIncomingLikes: [...incomingLikes].filter(id => (
        id !== user.uid && !activeProfileIds.has(id) && !blocked.has(id)
      )).length
    }
  };
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
  try {
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
  } catch (error) {
    if (!String(error?.code || "").endsWith("permission-denied")) throw error;
    const existingMatch = await getDoc(matchReference);
    if (!existingMatch.exists() || existingMatch.data().status !== "active") throw error;
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

async function getFreeCallAllowance(mode) {
  const user = requireUser();
  if (!["audio", "video"].includes(mode)) throw new Error("Choose a voice or video call.");
  const matches = await getMutualMatches();
  const callSnapshots = await Promise.all(matches.map(match => getDocs(query(
    collection(db, "matches", match.id, "calls"),
    where("callerId", "==", user.uid),
    limit(100)
  ))));
  const answeredSessions = new Map();
  callSnapshots.forEach(snapshot => {
    snapshot.forEach(item => {
      const call = item.data();
      const answeredAt = call.answeredAt?.toMillis?.();
      if (
        call.mode === mode
        && call.billingMode !== "paid"
        && answeredAt >= FREE_CALL_PROGRAM_START_MS
      ) {
        const sessionId = String(call.freeSessionId || item.id);
        const previous = answeredSessions.get(sessionId);
        if (!previous || answeredAt < previous) answeredSessions.set(sessionId, answeredAt);
      }
    });
  });
  const answeredCalls = [...answeredSessions.values()];
  answeredCalls.sort((first, second) => first - second);

  if (!answeredCalls.length) {
    return {
      allowed: true,
      remaining: 2,
      used: 0,
      period: 1,
      hasStarted: false,
      startsAt: null,
      periodEndsAt: null,
      trialEndsAt: null
    };
  }

  const day = 24 * 60 * 60 * 1000;
  const startsAt = answeredCalls[0];
  const trialEndsAt = startsAt + (30 * day);
  const now = Date.now();
  if (now >= trialEndsAt) {
    return {
      allowed: false,
      remaining: 0,
      used: answeredCalls.length,
      period: 4,
      hasStarted: true,
      expired: true,
      startsAt,
      periodEndsAt: trialEndsAt,
      trialEndsAt
    };
  }

  const elapsedDays = (now - startsAt) / day;
  const period = elapsedDays < 7 ? 1 : elapsedDays < 14 ? 2 : elapsedDays < 21 ? 3 : 4;
  const periodStartOffsets = [0, 0, 7, 14, 21];
  const periodEndOffsets = [0, 7, 14, 21, 30];
  const periodStartsAt = startsAt + (periodStartOffsets[period] * day);
  const periodEndsAt = startsAt + (periodEndOffsets[period] * day);
  const used = answeredCalls.filter(time => time >= periodStartsAt && time < periodEndsAt).length;
  const remaining = Math.max(0, 2 - used);
  return {
    allowed: remaining > 0,
    remaining,
    used,
    period,
    hasStarted: true,
    expired: false,
    startsAt,
    periodEndsAt,
    trialEndsAt
  };
}

async function getSentLikes() {
  const user = requireUser();
  const sentLikes = new Map();
  const blocked = new Set();
  const matchHistory = new Map();
  const [sentSnapshot, profilesSnapshot, matchesSnapshot, outgoingBlocks, incomingBlocks] = await Promise.all([
    getDocs(query(
      collection(db, "swipes"),
      where("fromId", "==", user.uid),
      limit(250)
    )),
    getDocs(query(
      collection(db, "datingProfiles"),
      where("active", "==", true)
    )),
    getDocs(query(
      collection(db, "matches"),
      where("memberIds", "array-contains", user.uid),
      limit(80)
    )),
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
  sentSnapshot.forEach(item => {
    const data = item.data();
    if (data.decision === "like") sentLikes.set(data.toId, data.updatedAt || data.createdAt || null);
  });
  outgoingBlocks.forEach(item => blocked.add(item.data().blockedId));
  incomingBlocks.forEach(item => blocked.add(item.data().blockerId));
  matchesSnapshot.forEach(item => {
    const data = item.data();
    const otherId = data.memberIds?.find(id => id !== user.uid);
    if (otherId) {
      matchHistory.set(otherId, {
        matchId: item.id,
        status: data.status,
        profile: data.profileSnapshots?.[otherId] || null
      });
    }
  });

  const currentProfiles = new Map();
  profilesSnapshot.forEach(item => currentProfiles.set(item.id, item.data()));
  const profiles = [];
  sentLikes.forEach((likedAt, targetId) => {
    if (blocked.has(targetId)) return;
    const match = matchHistory.get(targetId);
    const profile = currentProfiles.get(targetId) || match?.profile;
    if (!profile) return;
    profiles.push({
      ...profile,
      id: targetId,
      likedAt,
      matchId: match?.matchId || "",
      likeStatus: match?.status === "active"
        ? "matched"
        : match
          ? "previously_matched"
          : "pending"
    });
  });
  return profiles;
}

async function withdrawLike(targetId) {
  const user = requireUser();
  const cleanTargetId = String(targetId || "");
  if (!cleanTargetId || cleanTargetId === user.uid) throw new Error("That Like is unavailable.");
  const swipeReference = doc(db, "swipes", `${user.uid}_${cleanTargetId}`);
  const snapshot = await getDoc(swipeReference);
  if (!snapshot.exists() || snapshot.data().fromId !== user.uid || snapshot.data().decision !== "like") {
    throw new Error("That Like is no longer active.");
  }
  await setDoc(swipeReference, {
    decision: "pass",
    updatedAt: serverTimestamp()
  }, { merge: true });
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

async function createCallSignal(matchId, calleeId, mode, offer, callOptions = {}) {
  const user = requireUser();
  if (!matchId || !calleeId || calleeId === user.uid) throw new Error("That member cannot be called.");
  if (!["audio", "video"].includes(mode)) throw new Error("Choose a voice or video call.");
  const billingMode = callOptions.billingMode === "paid" ? "paid" : "free";
  const freeSessionId = String(callOptions.freeSessionId || "").slice(0, 180);
  const requestedFreeSeconds = Math.floor(Number(callOptions.freeSeconds) || 180);
  const freeSeconds = billingMode === "paid" ? 0 : Math.max(1, Math.min(180, requestedFreeSeconds));
  const response = await fetch("/.netlify/functions/create-call-signal", {
    method:"POST",
    headers:{
      Authorization:`Bearer ${await getIdToken(user)}`,
      "Content-Type":"application/json"
    },
    body:JSON.stringify({
      matchId,
      calleeId,
      mode,
      offer:safeSessionDescription(offer),
      billingMode,
      freeSessionId,
      freeSeconds
    }),
    cache:"no-store"
  });
  const payload = await response.json().catch(() => ({}));
  if(!response.ok) throw new Error(payload.error || "The call could not start.");
  return String(payload.callId || "");
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

function imageFileExtension(file) {
  return String(file?.name || "").split(".").pop().toLowerCase();
}

const DRAFT_PHOTO_PREFIX = "draftPhoto:";
const DRAFT_PHOTO_DATABASE = "first-option-dating-private-drafts";
const DRAFT_PHOTO_STORE = "profilePhotos";
let draftPhotoDatabasePromise = null;

function openDraftPhotoDatabase() {
  if (!window.indexedDB) throw new Error("Private picture drafts are not supported in this browser. Verify your email, then try again.");
  if (draftPhotoDatabasePromise) return draftPhotoDatabasePromise;
  draftPhotoDatabasePromise = new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DRAFT_PHOTO_DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DRAFT_PHOTO_STORE)) {
        request.result.createObjectStore(DRAFT_PHOTO_STORE, { keyPath:"id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Private picture storage could not open."));
  });
  return draftPhotoDatabasePromise;
}

function draftPhotoKey(path) {
  return String(path || "").startsWith(DRAFT_PHOTO_PREFIX)
    ? String(path).slice(DRAFT_PHOTO_PREFIX.length)
    : "";
}

async function getDraftPhotoRecord(path, user = requireUser()) {
  const id = draftPhotoKey(path);
  if (!id || !id.startsWith(`${user.uid}:`)) throw new Error("That private picture draft is unavailable.");
  const database = await openDraftPhotoDatabase();
  const record = await new Promise((resolve, reject) => {
    const request = database.transaction(DRAFT_PHOTO_STORE, "readonly").objectStore(DRAFT_PHOTO_STORE).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error("The private picture draft could not be read."));
  });
  if (!record || record.ownerId !== user.uid) throw new Error("That private picture draft is no longer on this device.");
  return record;
}

async function saveDraftPhoto(user, file) {
  const randomId = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  const id = `${user.uid}:${randomId}`;
  const database = await openDraftPhotoDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(DRAFT_PHOTO_STORE, "readwrite");
    transaction.objectStore(DRAFT_PHOTO_STORE).put({
      id,
      ownerId:user.uid,
      name:file.name || "profile-photo.jpg",
      type:file.type || "image/jpeg",
      blob:file,
      createdAt:Date.now()
    });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("The private picture draft could not be saved."));
    transaction.onabort = () => reject(transaction.error || new Error("The private picture draft could not be saved."));
  });
  return `${DRAFT_PHOTO_PREFIX}${id}`;
}

async function deleteDraftPhoto(path, user = requireUser()) {
  const record = await getDraftPhotoRecord(path, user);
  const database = await openDraftPhotoDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(DRAFT_PHOTO_STORE, "readwrite");
    transaction.objectStore(DRAFT_PHOTO_STORE).delete(record.id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("The private picture draft could not be removed."));
    transaction.onabort = () => reject(transaction.error || new Error("The private picture draft could not be removed."));
  });
}

async function decodeImageFile(file) {
  if ("createImageBitmap" in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (error) {
      try { return await createImageBitmap(file); } catch (fallbackError) {}
    }
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("This picture format could not be read. Try exporting it as JPEG."));
      image.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function canvasBlob(canvas, contentType, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("The picture could not be prepared for upload.")), contentType, quality);
  });
}

async function prepareProfilePhoto(file) {
  const safeTypes = ["image/jpeg", "image/png", "image/webp"];
  const appleTypes = ["image/heic", "image/heif", "image/avif"];
  const extension = imageFileExtension(file);
  const looksLikeImage = String(file?.type || "").startsWith("image/")
    || ["jpg", "jpeg", "png", "webp", "heic", "heif", "avif"].includes(extension);
  if (!looksLikeImage) throw new Error("Choose a picture from your photo library.");

  const needsConversion = !safeTypes.includes(file.type)
    || appleTypes.includes(file.type)
    || ["heic", "heif", "avif"].includes(extension)
    || file.size >= 4.75 * 1024 * 1024;
  if (!needsConversion) return file;

  const image = await decodeImageFile(file);
  try {
    const sourceWidth = Number(image.width || image.naturalWidth || 0);
    const sourceHeight = Number(image.height || image.naturalHeight || 0);
    if (!sourceWidth || !sourceHeight) throw new Error("The picture dimensions could not be read.");
    const maxDimension = 2200;
    const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("The picture could not be prepared in this browser.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    let quality = 0.88;
    let blob = await canvasBlob(canvas, "image/jpeg", quality);
    while (blob.size >= 4.75 * 1024 * 1024 && quality > 0.58) {
      quality -= 0.08;
      blob = await canvasBlob(canvas, "image/jpeg", quality);
    }
    if (blob.size >= 5 * 1024 * 1024) throw new Error("This picture is still too large after resizing. Choose a smaller picture.");
    const baseName = String(file.name || "profile-photo").replace(/\.[^.]+$/, "") || "profile-photo";
    return new File([blob], `${baseName}.jpg`, { type: "image/jpeg", lastModified: Date.now() });
  } finally {
    if (typeof image.close === "function") image.close();
  }
}

async function uploadPreparedProfilePhoto(user, preparedFile) {
  const extension = photoExtension(preparedFile.type);
  if (!extension) throw new Error("Choose a JPEG, PNG or WebP photo.");
  if (preparedFile.size >= 5 * 1024 * 1024) throw new Error("Each photo must be smaller than 5 MB.");
  const uniqueName = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}.${extension}`;
  const path = `profilePhotos/${user.uid}/${uniqueName}`;
  await uploadBytes(storageRef(storage, path), preparedFile, { contentType: preparedFile.type });
  return path;
}

async function uploadProfilePhoto(file) {
  const user = requireUser();
  const preparedFile = await prepareProfilePhoto(file);
  if (!user.emailVerified) return saveDraftPhoto(user, preparedFile);
  return uploadPreparedProfilePhoto(user, preparedFile);
}

async function commitPendingProfilePhotos(paths) {
  const user = requireUser();
  if (!user.emailVerified) throw new Error("Verify your email before uploading your saved pictures.");
  const pendingPaths = paths.filter(path => draftPhotoKey(path));
  if (!pendingPaths.length) return paths;
  const replacements = new Map();
  const uploadedPaths = [];
  try {
    for (const path of pendingPaths) {
      const record = await getDraftPhotoRecord(path, user);
      const preparedFile = record.blob instanceof File
        ? record.blob
        : new File([record.blob], record.name || "profile-photo.jpg", { type:record.type || record.blob.type || "image/jpeg" });
      const uploadedPath = await uploadPreparedProfilePhoto(user, preparedFile);
      replacements.set(path, uploadedPath);
      uploadedPaths.push(uploadedPath);
    }
  } catch (error) {
    await Promise.allSettled(uploadedPaths.map(path => deleteObject(storageRef(storage, path))));
    throw error;
  }
  await Promise.all(pendingPaths.map(path => deleteDraftPhoto(path, user)));
  return paths.map(path => replacements.get(path) || path);
}

async function loadProfilePhoto(path) {
  const user = requireUser();
  if (draftPhotoKey(path)) {
    const record = await getDraftPhotoRecord(path, user);
    return URL.createObjectURL(record.blob);
  }
  const blob = await getBlob(storageRef(storage, path), 5 * 1024 * 1024);
  return URL.createObjectURL(blob);
}

async function deleteProfilePhoto(path) {
  const user = requireUser();
  if (draftPhotoKey(path)) return deleteDraftPhoto(path, user);
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
  refreshVerification,
  getMyProfile,
  saveMyProfile,
  saveQuizResult,
  saveDatingProfile,
  getMyDatingProfile,
  findDatingProfiles,
  recordSwipe,
  getMutualMatches,
  getFreeCallAllowance,
  getSentLikes,
  withdrawLike,
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
  commitPendingProfilePhotos,
  loadProfilePhoto,
  deleteProfilePhoto,
  getCurrentUserIdToken,
  currentUser: () => publicUser(auth.currentUser)
};

window.dispatchEvent(new CustomEvent("ljt-firebase-ready"));

onAuthStateChanged(auth, user => {
  window.dispatchEvent(new CustomEvent("ljt-auth-change", {
    detail: { user: publicUser(user) }
  }));
});
