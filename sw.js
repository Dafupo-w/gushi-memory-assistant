const CACHE_NAME = "classical-text-memory-v6";
const BASE_URL = new URL("./", self.registration.scope);
const SHELL = [
  "index.html",
  "workspace.html",
  "styles.css",
  "workspace.css",
  "app.js",
  "workspace.js",
  "course-store.js",
  "manifest.webmanifest",
  "assets/app/icon-512.png"
].map(path => new URL(path, BASE_URL).href);

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET" || new URL(event.request.url).pathname.startsWith("/api/")) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(event.request, response.clone()));
    return response;
  }).catch(() => caches.match(event.request).then(cached => cached || caches.match(new URL("index.html", BASE_URL).href))));
});
