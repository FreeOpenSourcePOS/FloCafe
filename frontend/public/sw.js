const CACHE_NAME = 'flo-v17';
const PRECACHE_URLS = [
  '/dashboard',
  '/pos',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/logo.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.all(
        PRECACHE_URLS.map((url) => cache.add(url).catch(() => undefined))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys
        .filter((k) => k !== CACHE_NAME)
        .map((k) => caches.delete(k).catch(() => false)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Never cache API/setup/auth calls — these must reflect current DB state.
  if (
    url.hostname !== self.location.hostname ||
    url.pathname.startsWith('/api') ||
    url.pathname.startsWith('/auth') ||
    url.pathname.startsWith('/setup')
  ) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        event.waitUntil(
          caches.open(CACHE_NAME)
            .then((cache) => cache.put(event.request, clone))
            .catch(() => undefined)
        );
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => {
        if (cached) return cached;
        // For navigate requests, fall back to the cached dashboard shell so
        // the user sees the app rather than a browser error page. For
        // sub-resources (JS chunks, images etc.) do NOT return a fake 503 —
        // let the fetch fail transparently so the browser can retry. On a
        // desktop Electron app, the server is localhost and any failure is
        // transient; a fabricated 503 prevents the natural retry.
        if (event.request.mode === 'navigate') {
          return caches.match('/dashboard').then((shell) => shell || undefined);
        }
        return undefined;
      }))
  );
});
