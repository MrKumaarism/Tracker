/* ═══════════════════════════════════════════════════════
   Fuel Tracker — Service Worker
   Network-first for pages, stale-while-revalidate for assets
   ═══════════════════════════════════════════════════════ */

const CACHE_NAME = 'fuel-tracker-v12';

const APP_SHELL = [
    './',
    './index.html',
    './inventory.html',
    './reset.html',
    './style.css',
    './app.js',
    './inventory.js',
    './manifest.json',
    './icons/favicon.svg',
    './icons/apple-touch-icon-180.png',
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

// ─── Fetch ───
// Pages: network-first, so an updated app shell shows up on the very next load.
// Assets: stale-while-revalidate, since they are cheap to serve stale for one load.
self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;

    if (event.request.mode === 'navigate') {
        event.respondWith(networkFirst(event.request));
        return;
    }

    event.respondWith(staleWhileRevalidate(event.request));
});

async function networkFirst(request) {
    try {
        const response = await fetch(request);
        if (response && response.status === 200) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, response.clone());
        }
        return response;
    } catch {
        // Offline: the requested page, then index.html as last resort.
        return (await caches.match(request))
            || (await caches.match('./index.html'));
    }
}

async function staleWhileRevalidate(request) {
    const cached = await caches.match(request);

    const fetchPromise = fetch(request)
        .then((response) => {
            if (response && response.status === 200) {
                const clone = response.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
            }
            return response;
        })
        .catch(() => cached);

    return cached || fetchPromise;
}
