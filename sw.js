// Network-first for index.html and app.js so updates land immediately.
// Cache-first for recordings.js (155KB, never changes between deploys).
// No version bumping needed — just redeploy.

const CACHE = 'mot-static-v1';

// These never change — safe to serve from cache indefinitely
const IMMUTABLE = [
  '/recordings.js',
  '/icon-192.png',
  '/icon-512.png',
];

// Pre-cache immutable assets on install
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(IMMUTABLE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  const path = url.pathname;

  // Cache-first: immutable assets
  if (IMMUTABLE.some(p => path.endsWith(p.replace('/', '')))) {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request))
    );
    return;
  }

  // Network-first: index.html, app.js, trials.csv, manifest.json
  // Falls back to cache if offline
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
