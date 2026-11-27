/*
 * The dashboard shell, available offline.
 *
 * A local-first product should not show a browser error when the gateway is briefly down. This worker
 * caches the built shell (hashed assets are immutable) and answers a navigation with the cached shell
 * or an offline page; it never caches `/v1` — a cached API answer would be a stale measurement, which
 * is the one thing this dashboard refuses to show.
 */
const CACHE = 'omnihilbras-shell-v1';
const SHELL = ['/', '/dashboard', '/offline.html', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/v1') || url.pathname.startsWith('/metrics')) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/dashboard').then((cached) => cached ?? caches.match('/offline.html'))));
    return;
  }
  event.respondWith(caches.match(event.request).then((cached) => cached ?? fetch(event.request)));
});
