/* Service worker — makes the app installable and usable offline.
   Bump CACHE when you change the shell or rebuild the word list. */

const CACHE = 'sat-vocab-v15';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/css/style.css',
  './assets/js/main.js',
  './assets/js/store.js',
  './assets/js/session.js',
  './assets/js/scheduler.js',
  './assets/js/ability.js',
  './assets/js/quiz.js',
  './assets/js/stats.js',
  './assets/js/ui.js',
  './assets/js/auth.js',
  './assets/js/sheets.js',
  './assets/js/config.js',
  './assets/js/avatars.js',
  './assets/avatars/coleman.jpg',
  './assets/avatars/singer.jpg',
  './assets/avatars/packer.jpg',
  './assets/avatars/olson.jpg',
  './assets/avatars/griffin.jpg',
  './assets/avatars/cutrona.jpg',
  './data/words.json',
  './icons/icon.png',
];

/**
 * Precache the shell, bypassing the HTTP cache.
 *
 * `cache.addAll()` cannot do this: its requests go through the browser's own
 * HTTP cache, and GitHub Pages serves assets with a ten-minute max-age behind a
 * CDN. So a returning user would bump to a new CACHE version and then fill it
 * with the *old* files — which are then served cache-first, and the deploy
 * never arrives no matter how many times they reload. Bumping CACHE looked like
 * it forced an update; it only forced a re-copy of whatever was already stale.
 *
 * `cache: 'reload'` skips the HTTP cache on the way out and still writes the
 * fresh response to it on the way back, which is exactly what precaching wants.
 */
async function precache() {
  const cache = await caches.open(CACHE);
  await Promise.all(SHELL.map(async (url) => {
    try {
      const res = await fetch(new Request(url, { cache: 'reload' }));
      if (res.ok) await cache.put(url, res);
      else console.warn('[sw] skipped', url, res.status);
    } catch (err) {
      console.warn('[sw] skipped', url, err);
    }
  }));
}

self.addEventListener('install', (e) => {
  e.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Never cache Google APIs, Firebase or the auth scripts.
  if (url.origin !== self.location.origin) return;

  // HTML: network first, so a deploy is picked up immediately.
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request)
        .then((res) => { caches.open(CACHE).then((c) => c.put(request, res.clone())); return res; })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./'))),
    );
    return;
  }

  // Everything else: cache first, refresh in the background.
  e.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put(request, res.clone()));
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
