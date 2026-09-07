/* Service worker — makes the app installable and usable offline.
   Bump CACHE when you change the shell or rebuild the word list. */

const CACHE = 'sat-vocab-v9';
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
  './data/words.json',
  './icons/icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL).catch((err) => console.warn('[sw] partial precache', err)))
      .then(() => self.skipWaiting()),
  );
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
