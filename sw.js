const CACHE = "podcast21-v2";

const CORE = [
  "./",
  "index.html",
  "cabina.html",
  "podcast.html",
  "stats.html",
  "manifest.json",
  "css/style.css",
  "js/config.js",
  "js/app.js",
  "js/home.js",
  "js/podcast.js",
  "js/stats.js",
  "js/notificaciones.js",
  "js/pwa.js",
  "js/auth.js",
  "sw.js",
  "img/escudo.png",
  "img/icono-app.png",
  "img/cabina-icon.png",
  "img/podcast-icon.png",
  "img/logo-podcast21.png",
  "img/radio-anim.gif"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => Promise.allSettled(CORE.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ===== NETWORK-FIRST: siempre lo más reciente; caché solo sin conexión =====
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((cached) => cached || Response.error()))
  );
});
