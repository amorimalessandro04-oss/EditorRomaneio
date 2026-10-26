// Service worker — deixa o app funcionar 100% offline após a 1ª visita.
// Estratégia: cache-first para os arquivos do app (incluindo o WASM de 10 MB).
const CACHE = "romaneio-v1";
const ARQUIVOS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./src/calc.js",
  "./src/model.js",
  "./src/pdf.js",
  "./src/editor.js",
  "./vendor/mupdf/mupdf.js",
  "./vendor/mupdf/mupdf-wasm.js",
  "./vendor/mupdf/mupdf-wasm.wasm",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((chaves) =>
      Promise.all(chaves.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  // navegação -> serve o index (SPA)
  if (req.mode === "navigate") {
    e.respondWith(caches.match("./index.html").then((r) => r || fetch(req)));
    return;
  }
  e.respondWith(
    caches.match(req).then((cache) => cache || fetch(req).then((resp) => {
      // guarda no cache o que for do mesmo domínio (ex.: 1ª carga)
      if (resp && resp.ok && new URL(req.url).origin === self.location.origin) {
        const clone = resp.clone();
        caches.open(CACHE).then((c) => c.put(req, clone));
      }
      return resp;
    }).catch(() => cache))
  );
});
