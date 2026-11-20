// Service worker: rende l'app installabile e tiene in cache la "shell".
// Il database (*.sqlite.N) NON passa da qui: sql.js-httpvfs lo legge con
// richieste HTTP Range, che vanno lasciate andare dritte alla rete.
// Quando cambi app.js/style.css/index.html, incrementa VERSION.
const VERSION = "v1";
const CACHE = "akf-edible-" + VERSION;
const SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./sqlite.worker.js",
  "./sql-wasm.wasm",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith("akf-edible-") && k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Lascia passare: altri domini (Nominatim, GBIF, CDN, font), POST,
  // richieste Range e i file del database.
  if (
    req.method !== "GET" ||
    url.origin !== self.location.origin ||
    req.headers.has("range") ||
    /\.sqlite\.\d+$/.test(url.pathname)
  ) {
    return;
  }

  // Network-first: online prendi sempre l'ultima versione, offline usa la cache.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) => hit || (req.mode === "navigate" ? caches.match("./index.html") : undefined))
      )
  );
});
