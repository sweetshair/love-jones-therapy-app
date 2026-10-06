const { jsonResponse, parseJsonBody } = require("./_shared/http");
const { Timestamp, firestore, verifiedUser, authenticatedUser } = require("./_shared/firebase-admin");

const REFERRAL_REWARD_SECONDS = 3 * 60;

function cleanReferralCode(value) {
  const code = String(value || "").trim().toUpperCase();
  if (!/^FOD-[A-Z0-9]{6,20}$/.test(code)) throw new Error("That referral code is invalid.");
  return code;
}

function referralCodeForUid(uid) {
  return `FOD-${String(uid || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 10).toUpperCase()}`;
}

function walletCredit(wallet = {}, seconds = REFERRAL_REWARD_SECONDS) {
  return {
    balanceSeconds: Math.max(0, Number(wallet.balanceSeconds) || 0) + seconds,
    purchasedSeconds: Math.max(0, Number(wallet.purchasedSeconds) || 0),
    spentSeconds: Math.max(0, Number(wallet.spentSeconds) || 0),
    referralBonusSecondsAvailable: Math.max(0, Number(wallet.referralBonusSecondsAvailable) || 0) + seconds,
    referralBonusSecondsEarned: Math.max(0, Number(wallet.referralBonusSecondsEarned) || 0) + seconds,
    referralBonusSecondsSpent: Math.max(0, Number(wallet.referralBonusSecondsSpent) || 0)
  };
}

async function registerClaim(event, body) {
  const user = await authenticatedUser(event);
  if (!user) return jsonResponse(401, { error:"Sign in first." });
  const code = cleanReferralCode(body.referralCode);
  const db = firestore();
  const [ownUser, codeSnap] = await Promise.all([
    db.collection("users").doc(user.uid).get(),
    db.collection("referralCodes").doc(code).get()
  ]);
  if (!ownUser.exists) return jsonResponse(400, { error:"Finish creating your account first." });
  if (!codeSnap.exists) return jsonResponse(400, { error:"That referral code was not found." });
  const referrerId = String(codeSnap.data().ownerId || "");
  if (!referrerId || referrerId === user.uid) return jsonResponse(400, { error:"You cannot refer yourself." });

  const [referrerUser, referrerDeletion, referrerSuspension] = await Promise.all([
    db.collection("users").doc(referrerId).get(),
    db.collection("accountDeletions").doc(referrerId).get(),
    db.collection("accountSuspensions").doc(referrerId).get()
  ]);
  if (!referrerUser.exists) return jsonResponse(400, { error:"That referral code is unavailable." });
  if (referrerDeletion.exists || referrerSuspension.exists) {
    return jsonResponse(400, { error:"That referral code is unavailable." });
  }

  const claimRef = db.collection("referralClaims").doc(user.uid);
  const existing = await claimRef.get();
  if (existing.exists) {
    return jsonResponse(200, {
      registered: existing.data().referrerId === referrerId,
      status: existing.data().status || "pending"
    });
  }

  await claimRef.create({
    referredId:user.uid,
    referrerId,
    referralCode:code,
    status:"pending",
    rewardSeconds:REFERRAL_REWARD_SECONDS,
    createdAt:Timestamp.now()
  });
  return jsonResponse(200, { registered:true, status:"pending" });
}

async function referralStatus(event) {
  const user = await verifiedUser(event);
  if (!user) return jsonResponse(401, { error:"Verify your email and sign in first." });
  const db = firestore();
  const userRef = db.collection("users").doc(user.uid);
  const [userSnap, claims, walletSnap, ownClaim] = await Promise.all([
    userRef.get(),
    db.collection("referralClaims").where("referrerId", "==", user.uid).limit(250).get(),
    db.collection("callWallets").doc(user.uid).get(),
    db.collection("referralClaims").doc(user.uid).get()
  ]);

  if (!userSnap.exists) return jsonResponse(400, { error:"Complete your member account first." });
  const referralCode = referralCodeForUid(user.uid);
  const codeRef = db.collection("referralCodes").doc(referralCode);
  await db.runTransaction(async transaction => {
    const codeSnap = await transaction.get(codeRef);
    if (codeSnap.exists && codeSnap.data().ownerId !== user.uid) {
      throw new Error("Your referral code could not be reserved. Contact support.");
    }
    if (!codeSnap.exists) transaction.create(codeRef, { ownerId:user.uid, createdAt:Timestamp.now() });
    transaction.set(userRef, { referralCode, updatedAt:Timestamp.now() }, { merge:true });
  });

  let successfulReferrals = 0;
  let pendingReferrals = 0;
  claims.forEach(doc => {
    if (doc.data().status === "awarded") successfulReferrals += 1;
    else if (doc.data().status === "pending") pendingReferrals += 1;
  });

  const wallet = walletSnap.exists ? walletSnap.data() : {};
  return jsonResponse(200, {
    referralCode,
    rewardSeconds:REFERRAL_REWARD_SECONDS,
    successfulReferrals,
    pendingReferrals,
    referralBonusSecondsAvailable:Math.max(0, Number(wallet.referralBonusSecondsAvailable) || 0),
    referralBonusSecondsEarned:Math.max(0, Number(wallet.referralBonusSecondsEarned) || 0),
    ownReferralStatus:ownClaim.exists ? String(ownClaim.data().status || "pending") : "none"
  });
}

async function qualifyReferral(event) {
  const user = await verifiedUser(event);
  if (!user) return jsonResponse(401, { error:"Verify your email and sign in first." });

  const db = firestore();
  const claimRef = db.collection("referralClaims").doc(user.uid);
  const initialClaim = await claimRef.get();
  if (!initialClaim.exists) return jsonResponse(200, { awarded:false, qualified:false, reason:"no_referral" });

  const referrerId = String(initialClaim.data().referrerId || "");
  if (!referrerId || referrerId === user.uid) return jsonResponse(400, { error:"This referral is invalid." });

  let outcome = { awarded:false, qualified:false };
  await db.runTransaction(async transaction => {
    const referredUserRef = db.collection("users").doc(user.uid);
    const referredProfileRef = db.collection("datingProfiles").doc(user.uid);
    const referrerUserRef = db.collection("users").doc(referrerId);
    const referredWalletRef = db.collection("callWallets").doc(user.uid);
    const referrerWalletRef = db.collection("callWallets").doc(referrerId);

    const [
      claimSnap, referredUser, referredProfile, referrerUser,
      referredDeletion, referredSuspension, referrerDeletion, referrerSuspension,
      referredWallet, referrerWallet
    ] = await Promise.all([
      transaction.get(claimRef),
      transaction.get(referredUserRef),
      transaction.get(referredProfileRef),
      transaction.get(referrerUserRef),
      transaction.get(db.collection("accountDeletions").doc(user.uid)),
      transaction.get(db.collection("accountSuspensions").doc(user.uid)),
      transaction.get(db.collection("accountDeletions").doc(referrerId)),
      transaction.get(db.collection("accountSuspensions").doc(referrerId)),
      transaction.get(referredWalletRef),
      transaction.get(referrerWalletRef)
    ]);

    if (!claimSnap.exists) return;
    const claim = claimSnap.data();
    if (claim.status === "awarded") {
      outcome = { awarded:false, qualified:true, alreadyAwarded:true };
      return;
    }

    if (
      claim.status !== "pending"
      || claim.referredId !== user.uid
      || claim.referrerId !== referrerId
      || !referredUser.exists
      || !referredProfile.exists
      || !referrerUser.exists
      || referredDeletion.exists
      || referredSuspension.exists
      || referrerDeletion.exists
      || referrerSuspension.exists
    ) return;

    const member = referredUser.data();
    const profile = referredProfile.data();
    const qualified = Boolean(
      member.relationshipType
      && member.ageConfirmed === true
      && member.termsAcceptedAt
      && profile.ownerId === user.uid
      && profile.active === true
      && profile.termsAccepted === true
      && Array.isArray(profile.photoPaths)
      && profile.photoPaths.length > 0
    );
    if (!qualified) {
      outcome = { awarded:false, qualified:false };
      return;
    }

    const now = Timestamp.now();
    transaction.set(referredWalletRef, {
      ownerId:user.uid,
      ...walletCredit(referredWallet.exists ? referredWallet.data() : {}),
      updatedAt:now
    }, { merge:true });
    transaction.set(referrerWalletRef, {
      ownerId:referrerId,
      ...walletCredit(referrerWallet.exists ? referrerWallet.data() : {}),
      updatedAt:now
    }, { merge:true });
    transaction.update(claimRef, {
      status:"awarded",
      awardedAt:now,
      rewardSeconds:REFERRAL_REWARD_SECONDS
    });
    outcome = { awarded:true, qualified:true, rewardSeconds:REFERRAL_REWARD_SECONDS };
  });

  return jsonResponse(200, outcome);
}

exports.handler = async event => {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error:"Method not allowed." });
  try{
    const body = parseJsonBody(event);
    const action = String(body.action || "");
    if(action === "register") return registerClaim(event, body);
    if(action === "status") return referralStatus(event);
    if(action === "qualify") return qualifyReferral(event);
    return jsonResponse(400, { error:"The referral action is invalid." });
  }catch(error){
    console.error("Referral request failed:", error.message);
    return jsonResponse(400, { error:error.message || "Referral request failed." });
  }
};
