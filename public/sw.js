const CACHE_NAME = 'sales-dashboard-v6';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/today-invoices.html',
  '/dispatch.html',
  '/dispatch.css',
  '/dispatch.js',
  '/dispatch-state.mjs',
  '/manifest.json',
  '/icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.all(
        STATIC_ASSETS.map((url) =>
          fetch(url, { mode: 'no-cors' })
            .then((response) => {
              return cache.put(url, response);
            })
            .catch(() => {}),
        ),
      );
    }),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(cacheNames.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)));
    }),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const isDispatchApi = url.pathname === '/api/dispatch'
    || url.pathname.startsWith('/api/dispatch/')
    || url.pathname.startsWith('/api/dispatch-');
  if (isDispatchApi) {
    event.respondWith(fetch(request));
    return;
  }

  if (request.url.includes('/api/')) {
    // Sales data must never fall back to an unlabelled stale response.
    // Static assets remain offline-capable below; API failures stay visible.
    event.respondWith(fetch(request, { cache: 'no-store' }));
  } else {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request)
          .then((response) => {
            if (response.ok) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(request, clone);
              });
            }
            return response;
          })
          .catch(() => {
            return new Response('Offline', { status: 503, statusText: 'Offline' });
          });
      }),
    );
  }
});
