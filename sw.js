// First Option Dating • Relationship IQ
// Service worker with versioned cache (bump VERSION when you deploy changes)

const VERSION = "fod-riq-v29";
const CACHE_NAME = `${VERSION}-cache`;

const ASSETS = [
  "./",
  "./index.html",
  "./firebase-client.js",
  "./hero-couple.webp",
  "./hero-interracial.webp",
  "./hero-asian.webp",
  "./hero-latino.webp",
  "./hero-white.webp",
  "./hero-women.webp",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS.map(asset => new Request(asset, { cache:"reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => (
        (k.includes("ljt-riq-") || k.includes("fod-riq-")) && k !== CACHE_NAME
      ) ? caches.delete(k) : null))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Only handle GET
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isNavigation = req.mode === "navigate" || req.destination === "document";
  const isFreshAppFile = isSameOrigin && (
    isNavigation
    || req.destination === "script"
    || url.pathname.endsWith("/manifest.webmanifest")
  );

  // Network-first for the app shell and scripts so reopening the app gets updates.
  if (isFreshAppFile) {
    event.respondWith(
      fetch(req, { cache:"no-store" })
        .then((res) => {
          if(res.ok){
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(req);
          if(cached) return cached;
          if(isNavigation) return caches.match("./");
          return Response.error();
        })
    );
    return;
  }

  // Cache-first for everything else
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return res;
      });
    })
  );
});
