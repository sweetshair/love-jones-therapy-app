const FIREBASE_WEB_API_KEY = "AIzaSyAd8Fj3RRYXEju1z1ZfdW6351IGlN88Ono";
const CREDENTIAL_LIFETIME_SECONDS = 15 * 60;

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff"
    },
    body: JSON.stringify(body)
  };
}

function meteredDomain() {
  const domain = String(process.env.METERED_DOMAIN || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  if (!/^[a-z0-9-]+\.metered\.live$/i.test(domain)) {
    throw new Error("Metered domain is missing or invalid.");
  }
  return domain;
}

async function verifiedFirebaseUser(event) {
  const authorization = String(event.headers?.authorization || event.headers?.Authorization || "");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const lookup = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(FIREBASE_WEB_API_KEY)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: match[1] })
    }
  );
  if (!lookup.ok) return null;
  const payload = await lookup.json();
  const user = payload.users?.[0];
  return user?.localId && user.emailVerified ? user : null;
}

function safeIceServers(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(server => {
    const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
    return urls.length > 0 && urls.every(url => /^(stun|turn|turns):/i.test(String(url || "")));
  }).map(server => ({
    urls: server.urls,
    ...(server.username ? { username: server.username } : {}),
    ...(server.credential ? { credential: server.credential } : {})
  }));
}

exports.handler = async event => {
  if (event.httpMethod !== "POST") {
    return response(405, { error: "Method not allowed." });
  }

  try {
    const user = await verifiedFirebaseUser(event);
    if (!user) return response(401, { error: "Sign in with a verified account first." });

    const domain = meteredDomain();
    const secretKey = String(process.env.METERED_API_KEY || "").trim();
    if (!secretKey) throw new Error("Metered secret key is missing.");

    const createCredential = await fetch(
      `https://${domain}/api/v1/turn/credential?secretKey=${encodeURIComponent(secretKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expiryInSeconds: CREDENTIAL_LIFETIME_SECONDS,
          label: `fod-beta-${String(user.localId).slice(0, 12)}-${Date.now()}`
        })
      }
    );
    if (!createCredential.ok) throw new Error("Metered credential creation failed.");
    const credential = await createCredential.json();
    if (!credential.apiKey) throw new Error("Metered credential response was incomplete.");

    const fetchServers = await fetch(
      `https://${domain}/api/v1/turn/credentials?apiKey=${encodeURIComponent(credential.apiKey)}`,
      { headers: { Accept: "application/json" } }
    );
    if (!fetchServers.ok) throw new Error("Metered ICE server lookup failed.");
    const iceServers = safeIceServers(await fetchServers.json());
    if (!iceServers.length) throw new Error("Metered returned no ICE servers.");

    return response(200, {
      iceServers,
      expiresInSeconds: CREDENTIAL_LIFETIME_SECONDS
    });
  } catch (error) {
    console.error("TURN credential function failed:", error.message);
    return response(503, { error: "The secure call relay is temporarily unavailable." });
  }
};
