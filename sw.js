// Service Worker for Timothy Lutheran MDO
// Cache-first for static assets, network-only for API calls

const CACHE_NAME = 'tl-mdo-v2';

// Static assets to pre-cache on install
// Uses clean URLs (no .html) to match how Cloudflare Assets serves them
const PRECACHE_URLS = [
  '/',
  '/calendar',
  '/lookup',
  '/admin',
  '/clockin',
  '/notice',
  '/privacy',
  '/manifest.json',
  '/css/styles.css',
  '/css/admin.css',
  '/css/lookup.css',
  '/js/app.js',
  '/js/supabase.js',
  '/js/error-monitor.js',
  '/js/lookup.js',
  '/images/logo.png',
];

// ── Install: pre-cache static assets ────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

// ── Activate: clean up old caches ───────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch: routing strategy ──────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Network-only: Supabase API proxy and cross-origin requests
  if (url.pathname.startsWith('/sb/') || url.origin !== self.location.origin) {
    return; // fall through to browser default (network)
  }

  // Cache-first for same-origin requests, with network fallback
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;

      return fetch(request).then(response => {
        // Only cache successful, non-opaque GET responses
        if (
          request.method === 'GET' &&
          response.status === 200 &&
          response.type === 'basic'
        ) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback for navigation requests
        if (request.mode === 'navigate') {
          return caches.match('/index.html');
        }
      });
    })
  );
});
