/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

const CACHE_NAME = 'stock-manager-v2';
const STATIC_ASSETS = [
  './',
  'index.html',
  'manifest.json',
  'icon.svg',
  'https://fonts.googleapis.com/css2?family=Alexandria:wght@600;700&family=IBM+Plex+Sans+Arabic:wght@400;500&display=swap'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.warn('Pre-cache assets warning:', err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Don't intercept Supabase API calls or external mutations
  if (
    request.url.includes('/rest/v1/') ||
    request.url.includes('/auth/v1/') ||
    request.url.includes('supabase.co') ||
    request.method !== 'GET'
  ) {
    return;
  }

  // Network-first with cache fallback
  event.respondWith(
    fetch(request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseToCache);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        return caches.match(request).then((cachedResponse) => {
          if (cachedResponse) {
            return cachedResponse;
          }
          if (request.mode === 'navigate') {
            return caches.match('/index.html');
          }
          return new Response('المحتوى غير متوفر دون اتصال بالإنترنت', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: new Headers({ 'Content-Type': 'text/plain; charset=utf-8' }),
          });
        });
      })
  );
});
