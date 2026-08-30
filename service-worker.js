/* ═══════════════════════════════════════════════════════
   Fuel Tracker — Service Worker

   Network-first for everything, cache purely as an offline fallback.

   The old split (network-first pages, stale-while-revalidate assets) meant a
   push to GitHub only reached the phone on the *second* open, and any asset
   whose URL had not changed could stay stale indefinitely — which is why
   updating meant reinstalling the PWA. Freshness now never depends on a
   version string being bumped by hand; the cache only answers when the
   network does not.
   ═══════════════════════════════════════════════════════ */

const CACHE_NAME = 'fuel-tracker-v15';

// How long to wait for the network before falling back to cache. Without a
// timeout, "connected to wifi with no internet" hangs the app instead of
// failing over — the common airport/hotel/lift case on a phone.
const NETWORK_TIMEOUT_MS = 4000;

const APP_SHELL = [
    './',
    './index.html',
    './inventory.html',
    './reset.html',
    './style.css',
    './app.js',
    './inventory.js',
    './sw-register.js',
    './manifest.json',
    './icons/favicon.svg',
    './icons/apple-touch-icon-180.png',
    './icons/icon-192.png',
    './icons/icon-512.png',

    // Vendored third-party. These used to load from cdn.tailwindcss.com and
    // gstatic, which meant a cold offline start had no layout and no Firebase
    // at all — the ESM import threw before a single line of app.js ran.
    './vendor/tailwind.js',
    './vendor/firebase-app.js',
    './vendor/firebase-auth.js',
    './vendor/firebase-firestore.js',
    './vendor/material-symbols.woff2',
    './vendor/fonts.css',
    './vendor/bodoni-moda.woff2',
    './vendor/dm-sans.woff2',
];

// ─── Install: cache app shell ───
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) =>
            // cache:'reload' bypasses the browser's HTTP cache, so a fresh
            // install never seeds itself with the stale copies it was
            // supposed to replace.
            cache.addAll(APP_SHELL.map((url) => new Request(url, { cache: 'reload' })))
        )
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
self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;

    // Firestore talks over its own transport and does its own offline
    // queueing. Caching it would serve stale reads and break writes.
    if (new URL(event.request.url).origin !== self.location.origin) return;

    event.respondWith(networkFirst(event.request));
});

async function networkFirst(request) {
    try {
        // GitHub Pages serves everything with max-age=600, so a plain fetch()
        // can be answered from the browser's own HTTP cache and stay up to ten
        // minutes behind a push. cache:'no-cache' forces a revalidation — the
        // server answers 304 when nothing changed, so this is nearly free.
        // A navigation Request cannot carry an init, hence the rebuild by URL.
        const netRequest = request.mode === 'navigate'
            ? new Request(request.url, { cache: 'no-cache', credentials: 'same-origin' })
            : new Request(request, { cache: 'no-cache' });

        const response = await withTimeout(fetch(netRequest), NETWORK_TIMEOUT_MS);
        if (response && response.status === 200) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, response.clone());
        }
        return response;
    } catch {
        return (await caches.match(request))
            // Retry ignoring ?v= style cache-busting query strings.
            || (await caches.match(request, { ignoreSearch: true }))
            // A navigation to anything we have never seen still gets an app.
            || (request.mode === 'navigate' ? await caches.match('./index.html') : null)
            || Response.error();
    }
}

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
    ]);
}

// Lets a page ask the worker to activate immediately (used by reset.html).
self.addEventListener('message', (event) => {
    if (event.data === 'skipWaiting') self.skipWaiting();
});
