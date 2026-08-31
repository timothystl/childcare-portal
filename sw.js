// Service Worker for Timothy Lutheran MDO
// Cache-first for static assets, network-only for API calls

const CACHE_NAME = 'tl-mdo-v9';

// Static assets to pre-cache on install
// Uses clean URLs (no .html) to match how Cloudflare Assets serves them.
//
// ⚠️ cache.addAll() rejects as a whole if any single URL 404s, which leaves the
// worker installed with an empty cache and no offline fallback at all. Every
// entry here must exist in the repo.
//
// /portal is the parent manifest's start_url — an installed home screen icon
// opens it, so it and the assets it loads have to be in the offline shell.
//
// Admin, the staff app and the time clock each have their OWN manifest so that
// installing any of them lands on that app rather than the parent portal; all
// four manifests belong in the shell for the same reason.
const PRECACHE_URLS = [
  '/',
  '/portal',
  '/calendar',
  '/lookup',
  '/admin',
  '/staff',
  '/clockin',
  '/notice',
  '/privacy',
  '/manifest.json',
  '/manifest-admin.json',
  '/manifest-staff.json',
  '/manifest-clockin.json',
  '/css/styles.css',
  '/css/admin.css',
  '/css/lookup.css',
  '/css/portal.css',
  '/dist/portal.min.js',
  '/dist/supabase.min.js',
  '/dist/error-monitor.min.js',
  '/js/app.js',
  '/js/supabase.js',
  '/js/error-monitor.js',
  '/js/lookup.js',
  '/images/logo/apps/parent/parent-launcher-192.png',
  '/images/logo/brand-notification-badge-96.png',
  '/images/logo/apps/parent/parent-wordmark-on-light.png',
  '/images/logo/brand-splash-church-pale.png',
  '/images/icons/nav-today.png',
  '/images/icons/nav-recap.png',
  '/images/icons/nav-schedule.png',
  '/images/icons/nav-billing.png',
  '/images/icons/nav-messages.png',
  '/images/icons/nav-account.png',
  '/images/illustrations/empty-today.svg',
  '/images/illustrations/empty-recap.svg',
  '/images/illustrations/empty-schedule.svg',
  '/images/illustrations/empty-messages.svg',
  '/images/illustrations/empty-documents.svg',
  '/images/illustrations/empty-billing.svg',
  '/images/illustrations/payment-received.svg',
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
      icon:  '/images/logo/apps/parent/parent-launcher-192.png',
      badge: '/images/logo/brand-notification-badge-96.png',
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
