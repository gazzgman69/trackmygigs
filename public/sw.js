// BUILD_VERSION is injected by the server at runtime via /sw.js route
// Fallback to timestamp so each registration is unique if injection fails
const CACHE_VERSION = self.CACHE_VERSION || 'v-' + Date.now();
const CACHE_NAME = 'trackmygigs-' + CACHE_VERSION;

// Pre-cache the shell so the app still opens with no network.
// Index HTML is NOT cached here — fresh HTML always comes from network, and the
// offline.html fallback covers navigation when the network is unreachable.
const STATIC_ASSETS = [
  '/manifest.json',
  '/offline.html',
  '/icons/icon-192.svg',
  '/icons/icon-512.svg',
  '/config.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Never intercept non-GET requests
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never intercept API or auth calls — always hit the network
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return;

  // Navigation requests (HTML pages): network-first with offline.html fallback.
  // Fresh HTML is served whenever the network is reachable; if the fetch fails
  // (offline, flaky signal, Replit cold start), serve the precached offline shell
  // so the user gets a branded "you are offline" screen instead of Chrome's dino.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match('/offline.html').then((cached) =>
          cached || new Response(
            '<!DOCTYPE html><title>Offline</title><h1>Offline</h1><p>Check your connection.</p>',
            { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
          )
        )
      )
    );
    return;
  }

  // Versioned assets (URLs containing ?v=): cache-first — they're immutable for that version
  if (url.search.includes('v=')) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // Everything else: network-first with cache fallback (for offline support)
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});
