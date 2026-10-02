const { verifiedUser } = require("./_shared/firebase-admin");
const { jsonResponse, parseJsonBody } = require("./_shared/http");
const { createHash } = require("node:crypto");

const SUPPORTED_LANGUAGES = new Set(["en","es","fr","ht","pt","de","it","nl","pl","ru","uk","ar","hi","pa","zh","ja","ko","vi","tl"]);

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error:"Method not allowed." });
  try {
    const user = await verifiedUser(event);
    if (!user) return jsonResponse(401, { error:"Sign in with a verified account to translate messages." });
    const body = parseJsonBody(event);
    const text = String(body.text || "").trim();
    const target = String(body.target || "en").trim().toLowerCase();
    if (!text) return jsonResponse(400, { error:"Message text is required." });
    if (text.length > 1000) return jsonResponse(400, { error:"Messages must be 1,000 characters or fewer." });
    if (!SUPPORTED_LANGUAGES.has(target)) return jsonResponse(400, { error:"That language is not supported yet." });
    const db = require("./_shared/firebase-admin").firestore();
    const version = "v1";
    const cacheId = createHash("sha256").update(`${version}\0${target}\0${text}`).digest("hex");
    const cacheRef = db.collection("messageTranslationCache").doc(cacheId);
    const cached = await cacheRef.get();
    if (cached.exists) return jsonResponse(200, { ...cached.data(), cached:true });
    const apiKey = String(process.env.GOOGLE_TRANSLATE_API_KEY || "").trim();
    if (!apiKey) return jsonResponse(503, { error:"Translation service is not configured yet." });
    const response = await fetch("https://translation.googleapis.com/language/translate/v2?key=" + encodeURIComponent(apiKey), {
      method:"POST",
      headers:{ "Content-Type":"application/json; charset=utf-8" },
      body:JSON.stringify({ q:text, target, format:"text" })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return jsonResponse(502, { error:"Translation is temporarily unavailable." });
    const item = payload && payload.data && payload.data.translations && payload.data.translations[0];
    const translation = String((item && item.translatedText) || "");
    if (!translation) return jsonResponse(502, { error:"Translation service returned an empty response." });
    const result = { translation, detectedLanguage:String((item && item.detectedSourceLanguage) || ""), version };
    await cacheRef.set({ ...result, target, createdAt:require("./_shared/firebase-admin").Timestamp.now() });
    return jsonResponse(200, result);
  } catch (error) {
    console.error("Translation function failed", error && error.message ? error.message : error);
    return jsonResponse(500, { error:"Translation is temporarily unavailable." });
  }
};
