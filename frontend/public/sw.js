const CACHE_NAME = 'flo-v19';
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

// Cache keys are precached without a trailing slash (see PRECACHE_URLS), but
// requests for the same route can arrive with one — e.g. Next.js's <Link>
// prefetch of "/dashboard/" when trailingSlash is enabled for the desktop
// build. Normalizing avoids a spurious cache miss on an otherwise-cached page.
function normalizedUrlString(url) {
  const parsed = new URL(url);
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }
  return parsed.toString();
}

function matchCached(request) {
  return caches.match(request)
    .then((match) => match || caches.match(normalizedUrlString(
      typeof request === 'string' ? request : request.url
    )))
    .catch(() => null);
}

// A route prefetch (e.g. <Link> hovering/entering the viewport) fetches a
// page path the same way a real subresource would, but with request.mode
// other than "navigate". Treat it like a navigation for fallback purposes —
// it targets one of our own pages, not a script/image/font — so it gets a
// real HTTP response instead of a network-error Response.
function isPageRequest(request) {
  if (request.mode === 'navigate') return true;
  const lastSegment = new URL(request.url).pathname.split('/').pop() || '';
  return !lastSegment.includes('.');
}

function offlineResponse(request) {
  // Navigation (and page prefetches) need a real HTTP response so Electron
  // shows a useful offline state instead of a service-worker
  // promise-conversion error. True subresources (scripts, images, fonts) use
  // a network-error Response, which preserves normal failed-resource
  // semantics without inventing a body or caching a failure.
  if (isPageRequest(request)) {
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
  return typeof Response.error === 'function'
    ? Response.error()
    : new Response('', { status: 503, statusText: 'Offline' });
}

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
        // Never cache server failures. In particular, a startup 503 must not
        // become the cached response that masks a server which is now ready.
        if (response.ok) {
          const clone = response.clone();
          event.waitUntil(
            caches.open(CACHE_NAME)
              .then((cache) => cache.put(event.request, clone))
              .catch(() => undefined)
          );
        }

        // Network-first navigation can use a known-good shell when the local
        // server is temporarily returning an error during startup. Preserve a
        // non-navigation HTTP response as-is; it is already a valid Response.
        if (event.request.mode !== 'navigate' || response.ok || response.status < 500) {
          return response;
        }
        return matchCached(event.request)
          .then((cached) => cached || matchCached('/dashboard'))
          .then((cached) => cached || response);
      })
      .catch(() => matchCached(event.request)
        .then((cached) => cached || (
          isPageRequest(event.request) ? matchCached('/dashboard') : null
        ))
        .then((cached) => cached || offlineResponse(event.request))
      )
  );
});
