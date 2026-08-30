import { initializeApp } from "./vendor/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "./vendor/firebase-auth.js";
import { getFirestore, collection, doc, setDoc, deleteDoc, onSnapshot, writeBatch, enableIndexedDbPersistence } from "./vendor/firebase-firestore.js";

// ponytail: config duplicated from app.js on purpose — fuel tracker stays untouched.
const firebaseConfig = {
  apiKey: "AIzaSyDDI6XzGK9BMwpD6U9e1SMk8QiH9INyo6w",
  authDomain: "fuel-tracker-d77f5.firebaseapp.com",
  projectId: "fuel-tracker-d77f5",
  storageBucket: "fuel-tracker-d77f5.firebasestorage.app",
  messagingSenderId: "225380767873",
  appId: "1:225380767873:web:0d5cd443123e16fffa9580",
  measurementId: "G-811Z91PTSW"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const dbFirestore = getFirestore(app);

enableIndexedDbPersistence(dbFirestore).catch((err) => {
    console.warn("Firestore offline persistence error:", err);
});

/* ═══════════════════════════════════════════════════════
   Personal Inventory — price history, not expense tracking.
   Collection: users/{uid}/purchases
   ═══════════════════════════════════════════════════════ */

    // ─── Constants ───
    const LS_KEY = 'inventory_purchases';
    // Seeds for the suggestion lists. Both fields are free text — anything you
    // type becomes a suggestion for next time.
    const SEED_CATEGORIES = ['Produce', 'Dairy', 'Grains', 'Meat', 'Pantry', 'Frozen',
                             'Beverages', 'Household', 'Personal Care', 'Other'];
    const SEED_UNITS = ['piece', 'pack', '100g', '250g', '500g', 'kg', '250ml', '500ml', 'L', 'dozen'];
    // Warn (never block) when a price is wildly off the last one — usually a wrong unit.
    const PRICE_SANITY_FACTOR = 2;
    // How long the button holds its ✓ Saved state before going back to Save.
    const SAVED_MS = 1400;
    const LOOKUP_ROWS = 3;
    const SEARCH_DEBOUNCE_MS = 150;

    // Typing-effect placeholder
    const PLACEHOLDER_EXAMPLES = ['Milk', 'Rice', 'Dhaniya', 'Toor Dal', 'Amul Butter', 'Onion'];
    const TYPE_MS = 90, DELETE_MS = 45, HOLD_MS = 1400;

    // ─── State ───
    let purchases = [];
    let currentUser = null;
    let unsubscribeSnapshot = null;
    let editingId = null;
    let activeCategory = 'All';
    let searchTerm = '';
    let sortKey = 'purchased';
    let sortDir = 'desc';
    let searchTimer = null;

    // ─── DOM Helpers ───
    const $ = (s) => document.querySelector(s);
    const $$ = (s) => document.querySelectorAll(s);

    // ─── DOM Refs ───
    const form          = $('#invForm');
    const editIdInput   = $('#invEditId');
    const storeInput    = $('#invStore');
    const itemRows      = $('#itemRows');
    const rowTemplate   = $('#itemRowTemplate');
    const addItemBtn    = $('#addItemBtn');
    const submitText    = $('#invSubmitText');
    const submitBtn     = $('#invSubmitBtn');
    const cancelEditBtn = $('#invCancelEdit');
    const itemCount     = $('#invItemCount');
    const productList   = $('#productList');
    const categoryList  = $('#categoryList');
    const unitList      = $('#unitList');
    const storeList     = $('#storeList');
    const searchInput   = $('#invSearch');
    const filterBar     = $('#invFilters');
    const sortMobile    = $('#invSortMobile');
    const tableBody     = $('#dashTableBody');
    const dashCards     = $('#dashCards');
    const dashEmpty     = $('#dashEmpty');
    const dashCount     = $('#dashCount');
    const statProducts  = $('#stat-products');
    const statEntries   = $('#stat-entries');
    const statCategories = $('#stat-categories');
    const sidebarLoginBtn = $('#sidebarLoginBtn');
    const mobileLoginBtn  = $('#mobileLoginBtn');

    // ═══════════════════════════════════════════════════════
    //  PURE LOGIC
    // ═══════════════════════════════════════════════════════

    /** Normalise a typed name so spelling/case variants group together. */
    function slug(name) {
        return String(name).toLowerCase().trim()
            .replace(/[^a-z0-9\s]/g, '')
            .replace(/\s+/g, '-');
    }

    /** Title-case a typed label so "dairy" and "Dairy" stay one bucket. */
    function normaliseLabel(value) {
        return String(value).trim().replace(/\s+/g, ' ')
            .replace(/\b\w/g, (c) => c.toUpperCase());
    }

    /**
     * Purchase timestamp in epoch ms.
     * Rows written before auto-timestamping carry an ISO date string instead;
     * noon avoids the UTC-midnight rollover that shifts the day east of GMT.
     */
    function stampOf(entry) {
        if (typeof entry.purchasedAt === 'number') return entry.purchasedAt;
        const parsed = Date.parse(String(entry.purchaseDate) + 'T12:00:00');
        return Number.isNaN(parsed) ? (entry.createdAt ?? 0) : parsed;
    }

    /** Price in rupees. `unitPrice` is the pre-rename field name. */
    function priceOf(entry) {
        return typeof entry.price === 'number' ? entry.price : (entry.unitPrice ?? 0);
    }

    /**
     * Attach each entry's previous purchase of the same product.
     * One pass per product, so the whole table is annotated in O(n log n).
     */
    function annotate(entries) {
        const byProduct = new Map();
        for (const entry of entries) {
            const bucket = byProduct.get(entry.productKey) ?? [];
            byProduct.set(entry.productKey, [...bucket, entry]);
        }

        const previousOf = new Map();
        for (const [, rows] of byProduct) {
            const oldestFirst = [...rows].sort((a, b) => stampOf(a) - stampOf(b));
            oldestFirst.forEach((entry, i) => {
                if (i > 0) previousOf.set(entry.id, oldestFirst[i - 1]);
            });
        }

        return entries.map((entry) => {
            const previous = previousOf.get(entry.id) ?? null;
            const price = priceOf(entry);
            const was = previous ? priceOf(previous) : null;
            return {
                ...entry,
                price,
                stamp: stampOf(entry),
                previous,
                previousPrice: was,
                previousStamp: previous ? stampOf(previous) : null,
                deltaPct: was ? ((price - was) / was) * 100 : null,
            };
        });
    }

    /** Every purchase of one product, newest first, plus summary stats. */
    function historyFor(productKey) {
        if (!productKey) return null;

        const rows = purchases.filter(p => p.productKey === productKey);
        if (!rows.length) return null;

        const newestFirst = [...rows].sort((a, b) => stampOf(b) - stampOf(a));
        const prices = newestFirst.map(priceOf);
        const recent = prices.slice(0, 3);
        const cheapest = newestFirst.reduce((best, r) =>
            priceOf(r) < priceOf(best) ? r : best);

        return {
            rows: newestFirst,
            latest: newestFirst[0],
            count: newestFirst.length,
            min: Math.min(...prices),
            max: Math.max(...prices),
            avg3: recent.reduce((sum, p) => sum + p, 0) / recent.length,
            cheapestStore: cheapest.store,
            sparkline: prices.slice(0, 12).reverse(),
        };
    }

    /** Search across product, category, and store. */
    function matchesSearch(entry, term) {
        if (!term) return true;
        return [entry.productName, entry.category, entry.store]
            .some(v => String(v ?? '').toLowerCase().includes(term));
    }

    function sortEntries(entries, key, dir) {
        const factor = dir === 'asc' ? 1 : -1;
        const value = {
            product: e => e.productName.toLowerCase(),
            category: e => String(e.category ?? '').toLowerCase(),
            unit: e => String(e.unit ?? '').toLowerCase(),
            price: e => e.price,
            purchased: e => e.stamp,
        }[key] ?? (e => e.stamp);

        return [...entries].sort((a, b) => {
            const x = value(a), y = value(b);
            if (x < y) return -1 * factor;
            if (x > y) return 1 * factor;
            return stampOf(b) - stampOf(a); // stable-ish tiebreak: newest first
        });
    }

    /** Seed values plus everything already used, deduped and sorted. */
    function suggestionsFor(field, seeds = []) {
        const used = purchases.map(p => p[field]).filter(Boolean);
        return [...new Set([...seeds, ...used])].sort((a, b) => a.localeCompare(b));
    }

    // ═══════════════════════════════════════════════════════
    //  INIT
    // ═══════════════════════════════════════════════════════
    function init() {
        readStateFromUrl();
        addItemRow();
        bindEvents();
        initNavigation();
        initAuth();
        if (new URLSearchParams(location.search).has('selfcheck')) selfCheck();
    }

    /** Search, filter, and sort live in the URL so a view survives reload. */
    function readStateFromUrl() {
        const params = new URLSearchParams(location.search);
        searchTerm = (params.get('q') || '').toLowerCase().trim();
        activeCategory = params.get('cat') || 'All';

        const [key, dir] = (params.get('sort') || 'purchased:desc').split(':');
        sortKey = key || 'purchased';
        sortDir = dir === 'asc' ? 'asc' : 'desc';

        searchInput.value = params.get('q') || '';
        sortMobile.value = `${sortKey}:${sortDir}`;
    }

    function writeStateToUrl() {
        const params = new URLSearchParams();
        if (searchTerm) params.set('q', searchTerm);
        if (activeCategory !== 'All') params.set('cat', activeCategory);
        if (sortKey !== 'purchased' || sortDir !== 'desc') params.set('sort', `${sortKey}:${sortDir}`);

        const query = params.toString();
        history.replaceState(null, '', query ? `?${query}` : location.pathname);
    }

    // ═══════════════════════════════════════════════════════
    //  TYPING-EFFECT PLACEHOLDER
    // ═══════════════════════════════════════════════════════

    /**
     * Cycles an example product through the placeholder, one character at a
     * time. Returns a stop function.
     * setTimeout rather than rAF: this is a ~90ms cadence, and timers throttle
     * in a hidden tab for free.
     */
    function typingPlaceholder(input, examples) {
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            input.placeholder = `Type '${examples[0]}'...`;
            return () => {};
        }

        let timer = null, word = 0, chars = 0, deleting = false;

        const tick = () => {
            const example = examples[word % examples.length];
            chars += deleting ? -1 : 1;
            input.placeholder = `Type '${example.slice(0, chars)}'...`;

            let delay = deleting ? DELETE_MS : TYPE_MS;
            if (!deleting && chars === example.length) {
                deleting = true;
                delay = HOLD_MS;
            } else if (deleting && chars === 0) {
                deleting = false;
                word++;
                delay = TYPE_MS * 2;
            }
            timer = setTimeout(tick, delay);
        };

        tick();
        return () => { clearTimeout(timer); timer = null; };
    }

    /**
     * Animate exactly one product field — the first empty one. Several fields
     * typing at once is noise, and a moving placeholder under a live cursor
     * reads as broken.
     */
    function refreshPlaceholderAnimation() {
        const rows = [...itemRows.children];

        for (const row of rows) {
            const input = row.querySelector('.row-product');
            const isTarget = row === rows.find(r => !r.querySelector('.row-product').value)
                && document.activeElement !== input;

            if (isTarget && !input._stopTyping) {
                input._stopTyping = typingPlaceholder(input, PLACEHOLDER_EXAMPLES);
            } else if (!isTarget && input._stopTyping) {
                input._stopTyping();
                input._stopTyping = null;
                input.placeholder = '';
            }
        }
    }

    // ═══════════════════════════════════════════════════════
    //  ITEM ROWS
    // ═══════════════════════════════════════════════════════
    function addItemRow(values = null) {
        const row = rowTemplate.content.firstElementChild.cloneNode(true);
        const product = row.querySelector('.row-product');

        if (values) {
            product.value = values.productName || '';
            row.querySelector('.row-category').value = values.category || '';
            row.querySelector('.row-unit').value = values.unit || '';
            row.querySelector('.row-price').value = priceOf(values) || '';
        }

        product.addEventListener('input', () => {
            stopTypingOn(product);
            smartLookup(row);
        });
        product.addEventListener('change', () => smartLookup(row));
        product.addEventListener('focus', () => stopTypingOn(product));
        product.addEventListener('blur', refreshPlaceholderAnimation);
        row.querySelector('.row-price').addEventListener('input', updateItemCount);
        row.querySelector('.row-remove').addEventListener('click', () => removeItemRow(row));

        itemRows.appendChild(row);
        refreshRowChrome();
        refreshPlaceholderAnimation();
        return row;
    }

    function stopTypingOn(input) {
        if (!input._stopTyping) return;
        input._stopTyping();
        input._stopTyping = null;
        input.placeholder = '';
    }

    function removeItemRow(row) {
        // Never leave the form with nothing to fill in.
        if (itemRows.children.length === 1) {
            row.querySelectorAll('input').forEach(i => { i.value = ''; });
            row.querySelector('.row-lookup').classList.add('hidden');
        } else {
            row.remove();
        }
        refreshRowChrome();
        refreshPlaceholderAnimation();
        updateItemCount();
    }

    /** Renumber rows, hide the remove button when only one row is left. */
    function refreshRowChrome() {
        const rows = [...itemRows.children];
        rows.forEach((row, i) => {
            row.querySelector('.row-label').textContent = `Item ${i + 1}`;
            row.querySelector('.row-remove').classList.toggle('invisible', rows.length === 1);
        });
        submitText.textContent = editingId ? 'Update'
            : rows.length > 1 ? `Save all (${rows.length})`
            : 'Save';
    }

    function readRow(row) {
        return {
            productName: row.querySelector('.row-product').value.trim(),
            category: row.querySelector('.row-category').value.trim(),
            unit: row.querySelector('.row-unit').value.trim(),
            price: row.querySelector('.row-price').value.trim(),
            el: row,
        };
    }

    function updateItemCount() {
        const filled = [...itemRows.children]
            .map(readRow)
            .filter(r => parseFloat(r.price) > 0).length;
        itemCount.textContent = filled ? `${filled} item${filled > 1 ? 's' : ''} ready` : '';
    }

    // ═══════════════════════════════════════════════════════
    //  SMART LOOKUP
    // ═══════════════════════════════════════════════════════
    function smartLookup(row) {
        const panel = row.querySelector('.row-lookup');
        const history = historyFor(slug(row.querySelector('.row-product').value));

        if (!history) {
            panel.classList.add('hidden');
            panel.innerHTML = '';
            return;
        }

        // Prefill blanks only — never clobber something already typed.
        const categoryEl = row.querySelector('.row-category');
        const unitEl = row.querySelector('.row-unit');
        if (!categoryEl.value) categoryEl.value = history.latest.category || '';
        if (!unitEl.value) unitEl.value = history.latest.unit || '';

        const lines = history.rows.slice(0, LOOKUP_ROWS).map((entry, i) => `
            <div class="flex items-baseline justify-between gap-sm text-xs">
                <span class="font-bold text-on-surface-variant uppercase tracking-widest w-14 shrink-0">${i === 0 ? 'Last' : 'Before'}</span>
                <span class="font-bold text-on-surface">₹${fmt(priceOf(entry))}${entry.unit ? ` <span class="font-normal text-on-surface-variant">/ ${escapeHtml(entry.unit)}</span>` : ''}</span>
                <span class="text-on-surface-variant ml-auto">${formatStamp(stampOf(entry))}</span>
                ${entry.store ? `<span class="text-on-surface-variant truncate max-w-[8rem]">${escapeHtml(entry.store)}</span>` : ''}
            </div>`).join('');

        panel.innerHTML = `
            <div class="flex items-center justify-between gap-sm">
                <span class="text-[10px] font-bold text-on-surface uppercase tracking-widest">
                    ${escapeHtml(history.latest.productName)} · bought ${history.count} ${history.count === 1 ? 'time' : 'times'}
                </span>
                <span class="text-on-surface-variant">${sparkline(history.sparkline)}</span>
            </div>
            <div class="flex flex-col gap-1">${lines}</div>
            <div class="flex flex-wrap gap-x-md gap-y-1 text-[10px] font-bold text-on-surface-variant uppercase tracking-widest border-t border-dashed border-outline-variant pt-sm">
                <span>Low ₹${fmt(history.min)}</span>
                <span>High ₹${fmt(history.max)}</span>
                <span>Avg3 ₹${fmt(history.avg3)}</span>
                ${history.cheapestStore ? `<span>Cheapest ${escapeHtml(history.cheapestStore)}</span>` : ''}
            </div>`;
        panel.classList.remove('hidden');
    }

    // ═══════════════════════════════════════════════════════
    //  AUTH + DATA
    // ═══════════════════════════════════════════════════════
    function initAuth() {
        onAuthStateChanged(auth, (user) => {
            currentUser = user;
            updateAuthUI();
            if (user) {
                loadFirestoreData();
            } else {
                if (unsubscribeSnapshot) unsubscribeSnapshot();
                purchases = loadFromLocalStorage();
                render();
            }
        });
    }

    function updateAuthUI() {
        const icon = currentUser ? 'logout' : 'login';
        if ($('#sidebarLoginText')) $('#sidebarLoginText').textContent = currentUser ? 'Logout' : 'Sign in with Google';
        if ($('#mobileLoginText')) $('#mobileLoginText').textContent = currentUser ? 'Logout' : 'Login';
        if ($('#sidebarLoginIcon')) $('#sidebarLoginIcon').textContent = icon;
        if ($('#mobileLoginIcon')) $('#mobileLoginIcon').textContent = icon;
    }

    async function handleLoginClick() {
        if (currentUser) {
            await signOut(auth);
            showToast('Logged out');
        } else {
            try {
                await signInWithPopup(auth, new GoogleAuthProvider());
                showToast('Logged in successfully');
            } catch (err) {
                showToast('Login failed: ' + err.message);
            }
        }
    }

    function purchasesRef() {
        return collection(dbFirestore, 'users', currentUser.uid, 'purchases');
    }

    function loadFirestoreData() {
        if (!currentUser) return;
        if (unsubscribeSnapshot) unsubscribeSnapshot();

        unsubscribeSnapshot = onSnapshot(purchasesRef(), (snapshot) => {
            const rows = [];
            snapshot.forEach((d) => rows.push({ id: d.id, ...d.data() }));
            purchases = rows;
            render();
        }, (err) => {
            console.error('Firestore listen failed:', err);
            showToast(err.code === 'permission-denied'
                ? 'No access to your purchases — check Firestore rules'
                : 'Sync error — showing local data');
            purchases = loadFromLocalStorage();
            render();
        });
    }

    function loadFromLocalStorage() {
        try {
            const raw = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
            return Array.isArray(raw) ? raw : [];
        } catch (err) {
            console.error('Local read failed:', err);
            return [];
        }
    }

    function saveToLocalStorage() {
        try {
            localStorage.setItem(LS_KEY, JSON.stringify(purchases));
        } catch (err) {
            console.error('Local save failed:', err);
            showToast('Could not save locally — storage full?');
        }
    }

    /** Write a batch of entries in one shot. */
    async function persistAll(entries) {
        if (currentUser) {
            const batch = writeBatch(dbFirestore);
            for (const entry of entries) batch.set(doc(purchasesRef(), entry.id), entry);
            await batch.commit();
            return;
        }
        const ids = new Set(entries.map(e => e.id));
        purchases = [...purchases.filter(p => !ids.has(p.id)), ...entries];
        saveToLocalStorage();
        render();
    }

    async function removeEntry(id) {
        if (currentUser) {
            await deleteDoc(doc(purchasesRef(), id));
            return;
        }
        purchases = purchases.filter(p => p.id !== id);
        saveToLocalStorage();
        render();
    }

    // ═══════════════════════════════════════════════════════
    //  NAVIGATION
    // ═══════════════════════════════════════════════════════
    function initNavigation() {
        $$('.nav-link').forEach(link =>
            link.addEventListener('click', () => navigate(link.dataset.page)));
        $$('.bottom-nav-link').forEach(link =>
            link.addEventListener('click', () => navigate(link.dataset.page)));
    }

    function navigate(page) {
        if (!page) return;
        const target = $(`#page-${page}`);
        if (!target) return;

        $$('.page-section').forEach(s => s.classList.add('hidden'));
        target.classList.remove('hidden');
        target.style.animation = 'none';
        target.offsetHeight; // reflow
        target.style.animation = '';

        $$('.nav-link').forEach(l => l.classList.toggle('active', l.dataset.page === page));
        $$('.bottom-nav-link').forEach(l => l.classList.toggle('active', l.dataset.page === page));

        const titles = { log: 'Log', dashboard: 'Dashboard' };
        const headerTitle = $('#headerPageTitle');
        if (headerTitle) headerTitle.textContent = titles[page] || '';

        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // ═══════════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════════
    function bindEvents() {
        form.addEventListener('submit', handleSubmit);
        cancelEditBtn.addEventListener('click', resetForm);
        addItemBtn.addEventListener('click', () => {
            const row = addItemRow();
            row.querySelector('.row-product').focus();
            row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });

        searchInput.addEventListener('input', (e) => {
            clearTimeout(searchTimer);
            const value = e.target.value.toLowerCase().trim();
            searchTimer = setTimeout(() => {
                searchTerm = value;
                writeStateToUrl();
                renderDashboard();
            }, SEARCH_DEBOUNCE_MS);
        });

        filterBar.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-cat]');
            if (!btn) return;
            activeCategory = btn.dataset.cat;
            writeStateToUrl();
            renderFilters();
            renderDashboard();
        });

        $$('.sort-btn').forEach(btn => btn.addEventListener('click', () => {
            const key = btn.dataset.sort;
            // Same column toggles direction; a new column starts descending.
            if (sortKey === key) {
                sortDir = sortDir === 'asc' ? 'desc' : 'asc';
            } else {
                sortKey = key;
                sortDir = key === 'product' || key === 'category' || key === 'unit' ? 'asc' : 'desc';
            }
            sortMobile.value = `${sortKey}:${sortDir}`;
            writeStateToUrl();
            renderDashboard();
        }));

        sortMobile.addEventListener('change', (e) => {
            [sortKey, sortDir] = e.target.value.split(':');
            writeStateToUrl();
            renderDashboard();
        });

        if (sidebarLoginBtn) sidebarLoginBtn.addEventListener('click', handleLoginClick);
        if (mobileLoginBtn) mobileLoginBtn.addEventListener('click', handleLoginClick);
    }

    // ═══════════════════════════════════════════════════════
    //  SAVE
    // ═══════════════════════════════════════════════════════
    // True while a save is in flight. Without it, tapping Save three times
    // before Firestore answers wrote three separate rows for one product —
    // buildEntry() mints a fresh id per call, so nothing downstream could
    // recognise them as the same purchase.
    let saving = false;

    function handleSubmit(e) {
        e.preventDefault();
        if (saving) return;

        const rows = [...itemRows.children].map(readRow);
        // A row with nothing in it is not an error — it is just an unused slot.
        const touched = rows.filter(r => r.productName || r.category || r.unit || r.price);

        if (!touched.length) return showToast('Add at least one item');

        // Validate at the boundary: a zero price poisons every average downstream.
        for (const [i, row] of touched.entries()) {
            const label = touched.length > 1 ? `Item ${i + 1}: ` : '';
            if (!row.productName) return failRow(row, `${label}product name required`);
            if (!row.category) return failRow(row, `${label}category required`);
            if (!row.unit) return failRow(row, `${label}unit required`);
            if (!(parseFloat(row.price) > 0)) return failRow(row, `${label}price must be greater than 0`);
        }

        const entries = touched.map(buildEntry);
        const odd = editingId ? [] : entries.map(oddPrice).filter(Boolean);

        if (odd.length) {
            showConfirm(`${odd.join('; ')}. Wrong unit? Save anyway?`, () => commit(entries));
            return;
        }

        commit(entries);
    }

    function failRow(row, message) {
        row.el.querySelector('.row-product').scrollIntoView({ behavior: 'smooth', block: 'center' });
        showToast(message);
    }

    function buildEntry(row) {
        const existing = editingId ? purchases.find(p => p.id === editingId) : null;
        // The timestamp is captured here, at save. There is no date input.
        const now = Date.now();

        return {
            id: editingId || generateId(),
            purchasedAt: existing ? stampOf(existing) : now,
            createdAt: existing?.createdAt ?? now,
            productKey: slug(row.productName),
            productName: row.productName,
            category: normaliseLabel(row.category),
            unit: row.unit,
            price: parseFloat(row.price),
            store: storeInput.value.trim(),
        };
    }

    /** Message describing a suspicious price, or null when it looks normal. */
    function oddPrice(entry) {
        const history = historyFor(entry.productKey);
        if (!history) return null;
        const last = priceOf(history.latest);
        const tooHigh = entry.price > last * PRICE_SANITY_FACTOR;
        const tooLow = entry.price < last / PRICE_SANITY_FACTOR;
        if (!tooHigh && !tooLow) return null;
        return `${entry.productName} ₹${fmt(entry.price)} vs last ₹${fmt(last)}`;
    }

    async function commit(entries) {
        if (saving) return;

        // Capture the comparison before the new rows land in `purchases`.
        const previous = entries.map(e => historyFor(e.productKey));
        const wasEditing = Boolean(editingId);

        saving = true;
        setSaveState('saving');

        try {
            await persistAll(entries);
        } catch (err) {
            console.error('Save failed:', err);
            setSaveState('idle');
            saving = false;
            showToast(err.code === 'permission-denied'
                ? 'Save blocked by Firestore rules — allow users/{uid}/purchases'
                : 'Save failed: ' + err.message);
            return;
        }

        showToast(saveMessage(entries, previous, wasEditing));
        resetForm();

        // Hold the confirmation on the button itself for a moment. The toast
        // alone was too easy to miss on a phone, which is what led to the
        // repeat taps in the first place.
        setSaveState('saved');
        setTimeout(() => {
            setSaveState('idle');
            saving = false;
            itemRows.querySelector('.row-product').focus();
        }, SAVED_MS);
    }

    /** Drives the submit button through idle → saving → saved. */
    function setSaveState(state) {
        submitBtn.disabled = state !== 'idle';
        submitBtn.setAttribute('aria-busy', String(state === 'saving'));
        submitBtn.classList.toggle('opacity-70', state === 'saving');
        submitBtn.classList.toggle('bg-primary', state !== 'saved');
        submitBtn.classList.toggle('bg-secondary', state === 'saved');
        submitBtn.classList.toggle('text-on-primary', state !== 'saved');
        submitBtn.classList.toggle('text-on-secondary', state === 'saved');

        if (state === 'saving') submitText.textContent = 'Saving...';
        else if (state === 'saved') submitText.textContent = '✓ Saved';
        // refreshRowChrome owns the idle label — it knows about "Save all (n)".
        else refreshRowChrome();
    }

    function saveMessage(entries, previous, wasEditing) {
        if (wasEditing) return 'Entry updated';

        if (entries.length === 1) {
            const [entry] = entries;
            const [history] = previous;
            if (!history) return `${entry.productName} logged — first purchase`;
            const last = priceOf(history.latest);
            const delta = ((entry.price - last) / last) * 100;
            const dir = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat vs';
            return `${entry.productName} ₹${fmt(entry.price)} — ${dir} ${Math.abs(delta).toFixed(1)}% from ₹${fmt(last)}`;
        }

        return `${entries.length} items logged`;
    }

    function startEdit(id) {
        const entry = purchases.find(p => p.id === id);
        if (!entry) return;

        editingId = id;
        editIdInput.value = id;
        storeInput.value = entry.store || '';

        // Editing touches exactly one entry, so collapse to a single row.
        itemRows.innerHTML = '';
        addItemRow(entry);
        addItemBtn.classList.add('hidden');
        cancelEditBtn.classList.remove('hidden');
        refreshRowChrome();
        updateItemCount();

        navigate('log');
        form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function resetForm() {
        editingId = null;
        editIdInput.value = '';
        storeInput.value = '';
        itemRows.innerHTML = '';
        addItemRow();
        addItemBtn.classList.remove('hidden');
        cancelEditBtn.classList.add('hidden');
        refreshRowChrome();
        updateItemCount();
    }

    // ═══════════════════════════════════════════════════════
    //  RENDER
    // ═══════════════════════════════════════════════════════
    function render() {
        renderDatalists();
        renderFilters();
        renderStats();
        renderDashboard();
    }

    function renderDatalists() {
        const products = new Map();
        for (const p of purchases) products.set(p.productKey, p.productName);

        fillDatalist(productList, [...products.values()].sort((a, b) => a.localeCompare(b)));
        fillDatalist(categoryList, suggestionsFor('category', SEED_CATEGORIES));
        fillDatalist(unitList, suggestionsFor('unit', SEED_UNITS));
        fillDatalist(storeList, suggestionsFor('store'));
    }

    function fillDatalist(el, values) {
        el.innerHTML = values.map(v => `<option value="${escapeHtml(v)}"></option>`).join('');
    }

    function renderFilters() {
        const categories = ['All', ...suggestionsFor('category', SEED_CATEGORIES)];
        // A category can disappear when its last entry is deleted.
        if (!categories.includes(activeCategory)) activeCategory = 'All';

        filterBar.innerHTML = categories.map(c =>
            `<button type="button" data-cat="${escapeHtml(c)}" class="filter-pill ${c === activeCategory ? 'active' : ''} px-md py-xs rounded-full text-[11px] font-bold uppercase tracking-wider whitespace-nowrap">${escapeHtml(c)}</button>`
        ).join('');
    }

    function renderStats() {
        statProducts.textContent = new Set(purchases.map(p => p.productKey)).size;
        statEntries.textContent = purchases.length;
        statCategories.textContent = new Set(purchases.map(p => p.category).filter(Boolean)).size;
    }

    function renderDashboard() {
        const visible = sortEntries(
            annotate(purchases).filter(e =>
                (activeCategory === 'All' || e.category === activeCategory) &&
                matchesSearch(e, searchTerm)),
            sortKey, sortDir);

        dashEmpty.classList.toggle('hidden', visible.length > 0);
        dashEmpty.textContent = purchases.length
            ? 'No entries match this search or filter.'
            : 'Nothing logged yet. Add an item on the Log tab.';

        dashCount.textContent = visible.length
            ? `${visible.length} ${visible.length === 1 ? 'row' : 'rows'} · ${new Set(visible.map(e => e.productKey)).size} products`
            : '';

        renderSortIndicators();
        tableBody.innerHTML = visible.map(tableRow).join('');
        dashCards.innerHTML = visible.map(card).join('');
        bindRowActions();
    }

    function renderSortIndicators() {
        $$('.sort-btn').forEach(btn => {
            const active = btn.dataset.sort === sortKey;
            const arrow = active ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
            btn.textContent = btn.dataset.sort === 'purchased' ? 'Purchased' + arrow
                : btn.dataset.sort.charAt(0).toUpperCase() + btn.dataset.sort.slice(1) + arrow;
            btn.classList.toggle('text-on-surface', active);
        });
    }

    function deltaMarkup(entry) {
        if (entry.deltaPct === null) return '<span class="text-on-surface-variant">first purchase</span>';
        const up = entry.deltaPct > 0;
        const flat = entry.deltaPct === 0;
        const arrow = flat ? '—' : up ? '▲' : '▼';
        const tone = flat ? 'text-on-surface-variant' : up ? 'text-error' : 'text-secondary';
        return `<span class="${tone} font-bold">${arrow} ${Math.abs(entry.deltaPct).toFixed(1)}%</span>
                <span class="text-on-surface-variant">· was ₹${fmt(entry.previousPrice)} on ${formatStamp(entry.previousStamp, true)}</span>`;
    }

    function tableRow(entry) {
        return `
        <tr class="border-b border-outline-variant align-top">
            <td class="py-sm pr-md">
                <div class="font-bold text-on-surface">${escapeHtml(entry.productName)}</div>
                <div class="text-[11px] flex flex-wrap gap-x-1">${deltaMarkup(entry)}</div>
            </td>
            <td class="py-sm px-md text-on-surface-variant">${escapeHtml(entry.category)}</td>
            <td class="py-sm px-md text-on-surface-variant">${escapeHtml(entry.unit)}</td>
            <td class="py-sm px-md text-right font-bold text-on-surface whitespace-nowrap">₹${fmt(entry.price)}</td>
            <td class="py-sm px-md text-on-surface-variant whitespace-nowrap">
                ${formatStamp(entry.stamp)}
                ${entry.store ? `<div class="text-[11px]">${escapeHtml(entry.store)}</div>` : ''}
            </td>
            <td class="py-sm pl-md">
                <div class="flex gap-xs justify-end">
                    <button data-edit="${entry.id}" class="p-xs text-on-surface-variant hover:text-primary transition-colors" aria-label="Edit ${escapeHtml(entry.productName)}">
                        <span class="material-symbols-outlined text-[18px]">edit</span>
                    </button>
                    <button data-del="${entry.id}" class="p-xs text-on-surface-variant hover:text-error transition-colors" aria-label="Delete ${escapeHtml(entry.productName)}">
                        <span class="material-symbols-outlined text-[18px]">delete</span>
                    </button>
                </div>
            </td>
        </tr>`;
    }

    function card(entry) {
        return `
        <div class="ticket-card p-md flex flex-col gap-xs">
            <div class="flex items-start justify-between gap-sm">
                <span class="text-sm font-bold text-on-surface min-w-0 truncate">${escapeHtml(entry.productName)}</span>
                <span class="text-base font-bold text-on-surface shrink-0">₹${fmt(entry.price)}</span>
            </div>
            <div class="text-[10px] font-bold text-on-surface-variant uppercase tracking-widest">
                ${escapeHtml(entry.category)} · ${escapeHtml(entry.unit)}
            </div>
            <div class="text-[11px] text-on-surface-variant">
                ${formatStamp(entry.stamp)}${entry.store ? ' · ' + escapeHtml(entry.store) : ''}
            </div>
            <div class="flex items-center justify-between gap-sm pt-xs border-t border-dashed border-outline-variant">
                <div class="text-[11px] flex flex-wrap gap-x-1">${deltaMarkup(entry)}</div>
                <div class="flex gap-xs shrink-0">
                    <button data-edit="${entry.id}" class="p-xs text-on-surface-variant hover:text-primary transition-colors" aria-label="Edit ${escapeHtml(entry.productName)}">
                        <span class="material-symbols-outlined text-[18px]">edit</span>
                    </button>
                    <button data-del="${entry.id}" class="p-xs text-on-surface-variant hover:text-error transition-colors" aria-label="Delete ${escapeHtml(entry.productName)}">
                        <span class="material-symbols-outlined text-[18px]">delete</span>
                    </button>
                </div>
            </div>
        </div>`;
    }

    function bindRowActions() {
        $$('[data-edit]').forEach(btn =>
            btn.addEventListener('click', () => startEdit(btn.dataset.edit)));
        $$('[data-del]').forEach(btn =>
            btn.addEventListener('click', () => showConfirm('Delete this entry?', async () => {
                try {
                    await removeEntry(btn.dataset.del);
                    showToast('Entry deleted');
                } catch (err) {
                    console.error('Delete failed:', err);
                    showToast('Delete failed: ' + err.message);
                }
            })));
    }

    function sparkline(values) {
        if (values.length < 2) return '';
        const w = 60, h = 18;
        const min = Math.min(...values);
        const span = (Math.max(...values) - min) || 1;
        const pts = values.map((v, i) => {
            const x = (i / (values.length - 1)) * w;
            const y = h - ((v - min) / span) * h;
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        }).join(' ');
        return `<svg width="${w}" height="${h}" viewBox="-1 -1 ${w + 2} ${h + 2}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    }

    // ═══════════════════════════════════════════════════════
    //  UTILITIES
    // ═══════════════════════════════════════════════════════
    function generateId() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    /** "28 Aug, 12:45" — or "28 Aug" when only the day matters. */
    function formatStamp(ms, dateOnly = false) {
        if (!ms) return '—';
        const d = new Date(ms);
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const day = `${d.getDate()} ${months[d.getMonth()]}`;
        if (dateOnly) return day;
        const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        return `${day}, ${time}`;
    }

    function fmt(n) {
        if (!isFinite(n)) return '0';
        return Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
    }

    function escapeHtml(s) {
        return String(s ?? '').replace(/[&<>"']/g, (c) =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    }

    function showToast(msg) {
        const toast = $('#toast');
        toast.textContent = msg;
        toast.classList.add('toast-show');
        clearTimeout(toast._timer);
        toast._timer = setTimeout(() => toast.classList.remove('toast-show'), 3200);
    }

    function showConfirm(message, onConfirm) {
        const overlay = $('#confirmOverlay');
        $('#confirmMessage').textContent = message;
        overlay.classList.remove('hidden');

        // Clone the buttons to drop any listener left over from a previous confirm.
        const yes = $('#confirmYes');
        const no = $('#confirmNo');
        const close = () => {
            overlay.classList.add('hidden');
            yes.replaceWith(yes.cloneNode(true));
            no.replaceWith(no.cloneNode(true));
        };
        yes.addEventListener('click', () => { close(); onConfirm(); });
        no.addEventListener('click', close);
    }

    // ponytail: one self-check, covers the ways the pure logic actually breaks.
    // Run inventory.html?selfcheck=1 and watch the console.
    function selfCheck() {
        const day = (n) => new Date(2026, 7, n, 12).getTime();
        const rows = [
            { id: 'a', productKey: 'milk', productName: 'Milk', category: 'Dairy', unit: '1L',
              price: 30, purchasedAt: day(12), createdAt: 1, store: 'DMart' },
            { id: 'b', productKey: 'milk', productName: 'Milk', category: 'Dairy', unit: '1L',
              price: 32, purchasedAt: day(28), createdAt: 2, store: 'Local' },
            { id: 'c', productKey: 'rice', productName: 'Rice', category: 'Grains', unit: '5kg',
              price: 60, purchasedAt: day(5), createdAt: 3, store: 'DMart' },
            // Pre-rename row: ISO date + unitPrice, no purchasedAt.
            { id: 'd', productKey: 'dal', productName: 'Dal', category: 'Pantry', unit: '1kg',
              unitPrice: 142, purchaseDate: '2026-08-24', createdAt: 4, store: 'DMart' },
        ];

        const annotated = annotate(rows);
        const newMilk = annotated.find(e => e.id === 'b');
        const oldMilk = annotated.find(e => e.id === 'a');
        const rice = annotated.find(e => e.id === 'c');
        const legacy = annotated.find(e => e.id === 'd');

        console.assert(Math.abs(newMilk.deltaPct - 6.667) < 0.01, 'delta% wrong');
        console.assert(newMilk.previousPrice === 30, 'previous price wrong');
        console.assert(oldMilk.deltaPct === null, 'oldest entry has no previous');
        console.assert(rice.deltaPct === null, 'single entry must not divide by zero');
        console.assert(legacy.price === 142, 'legacy unitPrice must be read');
        console.assert(new Date(legacy.stamp).getDate() === 24, 'legacy date must not roll back a day');

        const sorted = sortEntries(annotated, 'price', 'desc');
        console.assert(sorted[0].id === 'd', 'price sort wrong');
        console.assert(sortEntries(annotated, 'purchased', 'desc')[0].id === 'b', 'date sort wrong');
        console.assert(matchesSearch(rows[0], 'dmart'), 'search must cover store');
        console.assert(slug('  Amul  Milk!! ') === 'amul-milk', 'slug normalisation wrong');
        console.assert(normaliseLabel('  dry   fruits ') === 'Dry Fruits', 'label normalisation wrong');
        console.log('inventory self-check done');
    }

    init();
