// Service worker: rede primeiro (sempre a versão mais nova), cache só como reserva offline.
// O fluxo de deploy troca __BUILD__ pelo hash do commit => cada publicação gera um SW novo => todos atualizam.
const BUILD = "__BUILD__";
const CACHE = "painel-" + BUILD;
const SHELL = ["./", "index.html", "app.js", "style.css", "config.js", "manifest.webmanifest", "icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const r = e.request;
  if (r.method !== "GET") return;
  if (new URL(r.url).origin !== location.origin) return; // a API é de outra origem e nunca passa pelo cache
  e.respondWith(
    fetch(r, { cache: "no-cache" })
      .then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(r, copy)); } return res; })
      .catch(() => caches.match(r).then((m) => m || caches.match("index.html"))));
});
