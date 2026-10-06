const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const privateHeaders = {
  "Cache-Control": "private, no-store",
  "Netlify-CDN-Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Vary": "Authorization"
};

// Storage rules permit only two Firestore document lookups. Keep all six
// privacy checks here, before reading any bytes, rather than relaxing rules.
function createPhotoHandler({ authenticatedUser, firestore, bucket }) {
  const fail = status => new Response("Photo unavailable.", { status, headers: privateHeaders });
  return async request => {
    if (request.method !== "GET") return fail(405);
    let user;
    try {
      user = await authenticatedUser({ headers: { authorization: request.headers.get("authorization") || "" } }, true);
    } catch { return fail(401); }
    if (!user?.email_verified || typeof user.uid !== "string" || user.uid.includes("/")) return fail(401);
    const path = new URL(request.url).searchParams.get("path") || "";
    const match = /^profilePhotos\/([^/]{1,128})\/([A-Za-z0-9_-][A-Za-z0-9._-]{0,200})$/.exec(path);
    if (!match || [".", ".."].includes(match[1])) return fail(400);
    const owner = match[1];
    try {
      const db = firestore();
      const paths = [...new Set([
        `accountDeletions/${user.uid}`, `accountSuspensions/${user.uid}`,
        `accountDeletions/${owner}`, `accountSuspensions/${owner}`,
        ...(owner === user.uid ? [] : [`blocks/${user.uid}_${owner}`, `blocks/${owner}_${user.uid}`])
      ])];
      const restrictions = await db.getAll(...paths.map(value => db.doc(value)));
      if (restrictions.some(record => record.exists)) return fail(403);
      const storage = bucket();
      const [metadata] = await storage.file(path).getMetadata();
      const size = Number(metadata.size);
      if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_PHOTO_BYTES
          || !["image/jpeg", "image/png", "image/webp"].includes(metadata.contentType)
          || !metadata.generation) return fail(404);
      // Pin the generation so an object replacement cannot evade metadata checks.
      const [bytes] = await storage.file(path, { generation: metadata.generation })
        .download({ start: 0, end: MAX_PHOTO_BYTES });
      if (bytes.length !== size || bytes.length > MAX_PHOTO_BYTES) return fail(404);
      // Netlify streaming supports the existing 5 MB photo limit without base64 overhead.
      const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
      return new Response(stream, { headers: { ...privateHeaders, "Content-Type": metadata.contentType } });
    } catch (error) {
      return fail(Number(error?.code) === 404 ? 404 : 503);
    }
  };
}

module.exports = { createPhotoHandler };
