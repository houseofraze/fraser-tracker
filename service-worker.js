// FLOW Tracker — Service Worker
// ──────────────────────────────────────────────────────────────────────────
// VERSION SYNC: APP_VERSION in index.html MUST match CACHE_VERSION below.
// When you deploy a new version of the app:
//   1. Bump APP_VERSION in index.html (near the top of the <script> block)
//   2. Bump CACHE_VERSION here to match
//   3. git commit; git push
// 
// Why both files: the browser only detects a "new" service worker when the
// service worker's BYTES change. If you only bump APP_VERSION in the HTML,
// the SW file is byte-identical to before, so the browser won't trigger a
// new install. Bumping CACHE_VERSION here changes the SW bytes too, which
// triggers the install/activate cycle and the user gets the update banner.
//
// Why network-first for HTML below: belt and braces. Even if you forget to
// bump CACHE_VERSION, network-first for HTML means a refresh always pulls
// the latest index.html when online. Offline users still get the cached
// shell.
// ──────────────────────────────────────────────────────────────────────────

const APP_VERSION = '2026.05.19.80';  // KEEP IN SYNC with index.html's APP_VERSION
const CACHE_VERSION = APP_VERSION;
const CACHE_NAME = `flow-tracker-${CACHE_VERSION}`;

// Files that make up the app shell — everything needed to render an empty
// usable app offline. Listed with relative paths so the SW works regardless
// of whether the app is at /flow-tracker/, /, or any sub-path.
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './apple-touch-icon.png',
  './apple-touch-icon-167.png',
  './apple-touch-icon-152.png'
];

// ─── INSTALL ────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // addAll is atomic — if any one URL fails to fetch, the whole install
      // fails. For app shell that's what we want: don't claim "installed" if
      // any required file is missing.
      return cache.addAll(APP_SHELL);
    })
  );
  // We do NOT skipWaiting() here — that lets the client decide when to
  // activate the new SW (via the update banner).
});

// ─── ACTIVATE ───────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k.startsWith('flow-tracker-') && k !== CACHE_NAME)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ─── MESSAGE: SKIP WAITING ──────────────────────────────────────────────
// Client sends this when user taps "Update now" in the update banner.
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ─── FETCH ──────────────────────────────────────────────────────────────
// Routing strategy:
//   - Same-origin HTML navigations (index.html, '/') -> NETWORK-FIRST.
//     Always try the network first so updates roll out immediately on next
//     page load. Falls back to cached shell when offline.
//   - Same-origin other GETs (icons, manifest) -> cache-first, populate on
//     miss. These rarely change so cache-first is faster.
//   - Google Fonts -> stale-while-revalidate.
//   - Everything else (cross-origin) -> network only, untouched.
//
// Non-GET requests are passed through untouched.
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // ── SAME-ORIGIN ──────────────────────────────────────────────────────
  if (url.origin === self.location.origin) {
    const acceptHeader = req.headers.get('accept') || '';
    const isHtmlNav = req.mode === 'navigate' || acceptHeader.includes('text/html');

    if (isHtmlNav) {
      // Network-first for HTML: the user's "refresh to see new version"
      // expectation works correctly. Fall back to cache if offline.
      event.respondWith(
        fetch(req).then(res => {
          if (res && res.ok && res.type === 'basic') {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(req, clone));
          }
          return res;
        }).catch(() => {
          // Offline: try matching the original URL, then the shell index
          return caches.match(req).then(c => c || caches.match('./index.html'));
        })
      );
      return;
    }

    // Non-HTML same-origin (icons, manifest, etc.): cache-first
    event.respondWith(
      caches.match(req).then(cached => {
        if (cached) return cached;
        return fetch(req).then(res => {
          if (res && res.ok && res.type === 'basic') {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(req, clone));
          }
          return res;
        }).catch(() => new Response('Offline', { status: 503, statusText: 'Offline' }));
      })
    );
    return;
  }

  // ── GOOGLE FONTS: stale-while-revalidate ─────────────────────────────
  if (url.host === 'fonts.googleapis.com' || url.host === 'fonts.gstatic.com') {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(req).then(cached => {
          const fetchPromise = fetch(req).then(res => {
            if (res && res.ok) cache.put(req, res.clone());
            return res;
          }).catch(() => cached);
          return cached || fetchPromise;
        })
      )
    );
    return;
  }

  // ── OTHER CROSS-ORIGIN: network only, untouched ──────────────────────
});
