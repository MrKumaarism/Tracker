/* ═══════════════════════════════════════════════════════
   Service worker registration + auto-update.

   Deliberately a plain script, not part of app.js: registration must not
   depend on the app module booting, and both pages need the same behaviour.

   The goal is that a push to GitHub shows up on next open with no reinstall
   and no manual cache clearing. Three things make that happen:
     1. updateViaCache:'none' — the browser must never serve service-worker.js
        from its HTTP cache, or an old worker can pin itself indefinitely.
     2. An explicit update() check on load and whenever the app is brought
        back to the foreground. An installed PWA can sit suspended for days.
     3. A one-shot reload when a new worker takes control, so the running page
        stops mixing old HTML with new assets.
   ═══════════════════════════════════════════════════════ */
(() => {
    if (!('serviceWorker' in navigator)) return;

    let reloading = false;

    // On a first-ever visit there is no controller yet, and clients.claim()
    // fires controllerchange straight away. Reloading then would just bounce
    // the page for no reason, so only react once a worker was already in
    // charge — that is the case that means "the code actually changed".
    const hadController = Boolean(navigator.serviceWorker.controller);

    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloading || !hadController) return;
        reloading = true;
        window.location.reload();
    });

    window.addEventListener('load', () => {
        navigator.serviceWorker.register('service-worker.js', { updateViaCache: 'none' })
            .then((reg) => {
                reg.update().catch(() => {});

                // iOS in particular freezes an installed PWA rather than
                // closing it, so "on load" alone can mean once a week.
                document.addEventListener('visibilitychange', () => {
                    if (document.visibilityState === 'visible') reg.update().catch(() => {});
                });
            })
            .catch(() => {});
    });
})();
