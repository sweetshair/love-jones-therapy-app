const { jsonResponse, parseJsonBody } = require('./_shared/http');
const { authenticatedUser, firestore, Timestamp } = require('./_shared/firebase-admin');
const { FieldPath } = require('firebase-admin/firestore');
const STATUSES = new Set(['new', 'under_review', 'resolved']);
const cleanId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const moderatorIds = () => String(process.env.MODERATOR_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);
const error = (status, message) => Object.assign(new Error(message), { status });

async function applyAction(db, actor, body, admins, suspensionEnabled) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw error(400, 'The request body is invalid.');
  if (!cleanId(body.reportId)) throw error(400, 'Choose a valid report.');
  if (!['status', 'suspend', 'restore'].includes(body.action)) throw error(400, 'Choose a valid action.');
  if (!Number.isInteger(body.version) || body.version < 0) throw error(400, 'Reload the report before updating it.');
  if (body.action === 'status' && !STATUSES.has(body.status)) throw error(400, 'Choose a valid report status.');
  const note = String(body.note || '').trim();
  if (!note || note.length > 1000) throw error(400, 'Add a review note of 1–1,000 characters.');
  if (body.action !== 'status') {
    if (!suspensionEnabled) throw error(503, 'Suspension controls are awaiting their security update.');
    if (body.confirmation !== (body.action === 'suspend' ? 'SUSPEND' : 'RESTORE')) throw error(400, 'Type the requested confirmation.');
  }
  const reportRef = db.collection('reports').doc(body.reportId);
  const auditRef = db.collection('moderationAudit').doc();
  await db.runTransaction(async tx => {
    const report = await tx.get(reportRef);
    if (!report.exists) throw error(404, 'Report not found.');
    const data = report.data();
    if ((data.moderationVersion || 0) !== body.version) throw error(409, 'This report changed. Refresh and review it again.');
    const targetId = data.targetId;
    if (!cleanId(targetId)) throw error(400, 'This report has an invalid member reference.');
    const now = Timestamp.now();
    if (body.action !== 'status') {
      if (targetId === actor || admins.includes(targetId)) throw error(403, 'Administrator accounts cannot be suspended here.');
      const suspensionRef = db.collection('accountSuspensions').doc(targetId);
      const [suspension, deletion, profile, user] = await Promise.all([
        tx.get(suspensionRef), tx.get(db.collection('accountDeletions').doc(targetId)),
        tx.get(db.collection('datingProfiles').doc(targetId)), tx.get(db.collection('users').doc(targetId))
      ]);
      if (deletion.exists) throw error(409, 'This account is being deleted or has been deleted.');
      if (!user.exists && !profile.exists) throw error(404, 'This member account is unavailable.');
      if (body.action === 'suspend') {
        if (suspension.exists) throw error(409, 'This member is already suspended. Refresh the list.');
        tx.create(suspensionRef, { reportId: report.id, suspendedBy: actor, reason: note, createdAt: now });
        if (profile.exists) tx.update(profile.ref, { active: false });
      } else {
        if (!suspension.exists) throw error(409, 'This member is not suspended. Refresh the list.');
        tx.delete(suspensionRef);
        // Restoration never republishes a hidden profile automatically.
      }
    }
    const nextStatus = body.action === 'status' ? body.status : data.status;
    tx.update(reportRef, { status: nextStatus, moderatorNote: note, reviewedBy: actor,
      reviewedAt: now, moderationVersion: body.version + 1 });
    tx.create(auditRef, { reportId: report.id, targetId, actorId: actor, action: body.action,
      previousStatus: data.status, status: nextStatus, note, createdAt: now });
  });
}

exports.handler = async event => {
  if (!['GET', 'POST'].includes(event.httpMethod)) return jsonResponse(405, { error: 'Method not allowed.' });
  try {
    const user = await authenticatedUser(event, true);
    if (!user) return jsonResponse(401, { error: 'Sign in first.' });
    const db = firestore();
    const [deletion, suspension] = await Promise.all([
      db.collection('accountDeletions').doc(user.uid).get(), db.collection('accountSuspensions').doc(user.uid).get()
    ]);
    const admins = moderatorIds();
    const allowed = user.email_verified === true && admins.includes(user.uid) && !deletion.exists && !suspension.exists;
    const suspensionEnabled = process.env.MODERATION_SUSPENSION_ENABLED === 'true';
    if (event.httpMethod === 'GET' && event.queryStringParameters?.action === 'access') {
      return jsonResponse(200, { allowed, suspended: suspension.exists, suspensionEnabled: allowed && suspensionEnabled });
    }
    if (!allowed) return jsonResponse(403, { error: 'Administrator access is required.' });
    if (event.httpMethod === 'POST') {
      let body;
      try { body = parseJsonBody(event); } catch (_) { throw error(400, 'The request body is invalid.'); }
      await applyAction(db, user.uid, body, admins, suspensionEnabled);
      return jsonResponse(200, { saved: true });
    }
    const status = event.queryStringParameters?.status || 'new';
    if (!STATUSES.has(status)) throw error(400, 'Choose a valid report status.');
    const after = event.queryStringParameters?.after;
    if (after && !cleanId(after)) throw error(400, 'The page reference is invalid.');
    let query = db.collection('reports').where('status', '==', status).orderBy(FieldPath.documentId()).limit(26);
    if (after) query = query.startAfter(after);
    const snapshot = await query.get();
    const reports = await Promise.all(snapshot.docs.slice(0, 25).map(async report => {
      const data = report.data();
      const targetId = cleanId(data.targetId) ? data.targetId : '';
      const [profile, suspended, deleted] = targetId ? await Promise.all([
        db.collection('datingProfiles').doc(targetId).get(),
        db.collection('accountSuspensions').doc(targetId).get(),
        db.collection('accountDeletions').doc(targetId).get()
      ]) : [];
      return { id: report.id, targetId, reporterId: String(data.reporterId || ''),
        memberName: String(profile?.data()?.displayName || 'Unavailable profile'),
        reason: String(data.reason || ''), details: String(data.details || '').slice(0,1000),
        status: data.status, note: String(data.moderatorNote || '').slice(0,1000),
        createdAt: data.createdAt?.toDate?.().toISOString() || null,
        version: data.moderationVersion || 0, suspended: !!suspended?.exists,
        deleted: !!deleted?.exists, protected: admins.includes(targetId) };
    }));
    return jsonResponse(200, { reports, next: snapshot.size > 25 ? reports[24].id : null, suspensionEnabled });
  } catch (failure) {
    const status = failure.status || (String(failure.code || '').startsWith('auth/') ? 401 : 503);
    return jsonResponse(status, { error: failure.status ? failure.message : status === 401
      ? 'Sign in again to continue.' : 'Reports are temporarily unavailable. Please retry.' });
  }
};
exports.applyAction = applyAction;
