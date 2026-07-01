// Service Worker for Timothy Lutheran MDO
// Cache-first for static assets, network-only for API calls

const CACHE_NAME = 'tl-mdo-v5';

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

  // Network-first for HTML pages, JS, and CSS (so code/style changes are always
  // picked up — CSS used to be cache-first, which could strand a browser on a
  // stale stylesheet indefinitely if it was already cached under the same URL).
  // Cache-first for images and other truly static assets.
  const isHtmlOrJsOrCss = request.mode === 'navigate' ||
                          url.pathname.endsWith('.js') ||
                          url.pathname.endsWith('.css') ||
                          url.pathname === '/admin' ||
                          url.pathname === '/';

  if (isHtmlOrJsOrCss) {
    // Network-first: try network, fall back to cache if offline
    event.respondWith(
      fetch(request).then(response => {
        if (request.method === 'GET' && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return response;
      }).catch(() => caches.match(request))
    );
    return;
  }

  // Cache-first for static assets (CSS, images, fonts)
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        if (request.method === 'GET' && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return response;
      });
    })
  );
});

// ── Push notifications ────────────────────────────────────────────────────────

self.addEventListener('push', event => {
  let data = { title: 'Timothy Lutheran MDO', body: '' };
  if (event.data) {
    try { data = { ...data, ...event.data.json() }; }
    catch { data.body = event.data.text(); }
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body:  data.body,
      icon:  '/images/logo.png',
      badge: '/images/logo.png',
      tag:   data.tag || 'mdo',
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes('/calendar') && 'focus' in c) return c.focus();
      }
      return clients.openWindow('/calendar');
    })
  );
});
