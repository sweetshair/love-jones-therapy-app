// Love Jones Therapy • Relationship IQ
// Service worker with versioned cache (bump VERSION when you deploy changes)

const VERSION = "ljt-riq-v11";
const CACHE_NAME = `${VERSION}-cache`;

const ASSETS = [
  "./",
  "./index.html",
  "./firebase-client.js",
  "./assets/hero-couple.webp",
  "./assets/hero-interracial.webp",
  "./assets/hero-asian.webp",
  "./assets/hero-latino.webp",
  "./assets/hero-white.webp",
  "./assets/hero-women.webp",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => (k.includes("ljt-riq-") && k !== CACHE_NAME) ? caches.delete(k) : null))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Only handle GET
  if (req.method !== "GET") return;

  // Network-first for HTML so you see updates faster
  if (req.headers.get("accept")?.includes("text/html")) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((m) => m || caches.match("./")))
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
