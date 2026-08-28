/* ═══════════════════════════════════════════════════════
   Fuel Tracker — Service Worker
   Stale-while-revalidate for app shell + CDN resources
   ═══════════════════════════════════════════════════════ */

const CACHE_NAME = 'fuel-tracker-v5';

const APP_SHELL = [
    './',
    './index.html',
    './inventory.html',
    './style.css',
    './app.js',
    './inventory.js',
    './manifest.json',
    './icons/favicon.svg',
    './icons/icon-192.png',
    './icons/icon-512.png',
];

// ─── Install: cache app shell ───
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
    );
    self.skipWaiting();
});

// ─── Activate: clean old caches ───
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        )
    );
    self.clients.claim();
});

// ─── Fetch: stale-while-revalidate ───
self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;

    event.respondWith(
        caches.match(event.request).then((cached) => {
            const fetchPromise = fetch(event.request)
                .then((response) => {
                    if (response && response.status === 200) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                    }
                    return response;
                })
                .catch(() => {
                    // Offline: serve the requested page from cache, index.html as last resort
                    if (event.request.mode === 'navigate') {
                        return cached || caches.match('./index.html');
                    }
                    return cached;
                });

            // Return cached version immediately if available, otherwise wait for network
            return cached || fetchPromise;
        })
    );
});
