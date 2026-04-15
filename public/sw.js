// BUILD_VERSION is injected by the server at runtime via /sw.js route
// Fallback to timestamp so each registration is unique if injection fails
const CACHE_VERSION = self.CACHE_VERSION || 'v-' + Date.now();
const CACHE_NAME = 'trackmygigs-' + CACHE_VERSION;

// Only cache genuinely static assets (no HTML — HTML must always come from network)
const STATIC_ASSETS = [
  '/manifest.json',
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

  // Navigation requests (HTML pages): network-first, NO cache fallback
  // This ensures a fresh page is always loaded on normal reload
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request));
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
