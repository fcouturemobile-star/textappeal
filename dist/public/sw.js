// Text Appeal PWA Service Worker
const CACHE_NAME = 'textappeal-v2';
const OFFLINE_URL = '/offline.html';

// Pre-cache essential assets on install
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll([
        '/',
        '/favicon.png',
        '/favicon.svg',
        '/icon-192x192.png',
        '/icon-512x512.png',
        '/manifest.json',
        '/offline.html'
      ]);
    })
  );
  self.skipWaiting();
});

// Clean up old caches on activate
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// Network-first strategy for API calls, cache-first for static assets
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Never cache API calls
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // For navigation requests, try network first, fall back to cache, then offline page
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => {
        return caches.match(event.request).then(cached => {
          return cached || caches.match(OFFLINE_URL);
        });
      })
    );
    return;
  }

  // For HTML files, use network-first (so deployments take effect immediately)
  if (url.pathname.endsWith('.html') || url.pathname === '/' || !url.pathname.match(/\.[a-z0-9]+$/i)) {
    event.respondWith(
      fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // For other requests (JS, CSS, images), try cache first, then network
  event.respondWith(
    caches.match(event.request).then(cached => {
      return cached || fetch(event.request).then(response => {
        if (response.ok && url.pathname.match(/\.(js|css|png|svg|woff2?)$/)) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
