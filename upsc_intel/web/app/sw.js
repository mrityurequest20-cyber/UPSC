/* UPSC Intel app: offline support. The app shell is cached when the service worker installs; the data
   (../data/*.json) always comes from the network first and the last copy is kept, so the app still opens
   offline on the days it has loaded. The web reader, Wikipedia and YouTube are never cached here. */
const VERSION = "__BUILD__";  // the export stamps each build, so a new build installs a fresh shell
const SHELL = `upsc-app-shell-${VERSION}`;
const DATA = "upsc-app-data";
const DATA_MAX = 90;  // day, practice, flashcard, month and meta files kept for offline use
const PDF = "upsc-app-pdf";
const PDF_MAX = 3;    // Daily Brief PDFs kept for offline reading
const FILES = ["./", "index.html", "app.css", "app.js", "../static/intel-core.js", "manifest.webmanifest", "icon.svg",
  "icons/icon-192.png", "icons/icon-512.png", "icons/maskable-512.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL)
    .then((cache) => cache.addAll(FILES.map((f) => new Request(f, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith("upsc-app-shell-") && k !== SHELL).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const scope = new URL(self.registration.scope);
  const site = new URL("../", scope).pathname;
  if (url.pathname.startsWith(`${site}data/`)) event.respondWith(fresh(req, url));
  else if (url.pathname.startsWith(scope.pathname) || url.pathname === `${site}static/intel-core.js`) event.respondWith(shell(req));
});

async function fresh(req, url) {
  const key = url.origin + url.pathname;  // the ?v= and ?t= stamps change every build: keep one copy per file
  const pdf = url.pathname.endsWith(".pdf");  // Daily Brief PDFs: the last few opened, apart from the data files
  const cache = await caches.open(pdf ? PDF : DATA);
  try {
    const res = await fetch(req);
    if (res.ok) {
      await cache.put(key, res.clone());
      const keys = await cache.keys();
      const max = pdf ? PDF_MAX : DATA_MAX;
      for (const old of keys.slice(0, Math.max(0, keys.length - max))) await cache.delete(old);
    }
    return res;
  } catch (err) {
    const hit = await cache.match(key);
    if (hit) return hit;
    throw err;
  }
}

async function shell(req) {
  const hit = await caches.match(req, { ignoreSearch: true, cacheName: SHELL });
  return hit || fetch(req);
}
