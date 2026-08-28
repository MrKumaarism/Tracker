import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { getFirestore, collection, doc, setDoc, deleteDoc, onSnapshot, writeBatch, enableIndexedDbPersistence } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

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
   Personal Inventory — Application Logic
   Separate collection from fuel entries: users/{uid}/purchases
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
    const RECENT_LIMIT = 30;
    // Quantity is fixed: one line per item, the unit carries the pack size.
    const FIXED_QUANTITY = 1;

    // ─── State ───
    let purchases = [];
    let currentUser = null;
    let unsubscribeSnapshot = null;
    let editingId = null;
    let activeCategory = 'All';
    let searchTerm = '';

    // ─── DOM Helpers ───
    const $ = (s) => document.querySelector(s);
    const $$ = (s) => document.querySelectorAll(s);

    // ─── DOM Refs ───
    const form          = $('#invForm');
    const editIdInput   = $('#invEditId');
    const storeInput    = $('#invStore');
    const dateInput     = $('#invDate');
    const itemRows      = $('#itemRows');
    const rowTemplate   = $('#itemRowTemplate');
    const addItemBtn    = $('#addItemBtn');
    const submitText    = $('#invSubmitText');
    const cancelEditBtn = $('#invCancelEdit');
    const totalPreview  = $('#invTotalPreview');
    const productList   = $('#productList');
    const categoryList  = $('#categoryList');
    const unitList      = $('#unitList');
    const storeList     = $('#storeList');
    const logList       = $('#logList');
    const logEmpty      = $('#logEmpty');
    const priceList     = $('#priceList');
    const priceEmpty    = $('#priceEmpty');
    const searchInput   = $('#invSearch');
    const filterBar     = $('#invFilters');
    const statProducts  = $('#stat-products');
    const statEntries   = $('#stat-entries');
    const statMonth     = $('#stat-month');
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

    /** Title-case a typed category so "dairy" and "Dairy" stay one bucket. */
    function normaliseLabel(value) {
        return String(value).trim().replace(/\s+/g, ' ')
            .replace(/\b\w/g, (c) => c.toUpperCase());
    }

    /** ISO date strings sort lexicographically — newest first. */
    function compareDesc(a, b) {
        return a < b ? 1 : a > b ? -1 : 0;
    }

    /** Group purchases by productKey and derive price-comparison stats. */
    function priceHistory(entries) {
        const byProduct = new Map();

        for (const entry of entries) {
            const bucket = byProduct.get(entry.productKey) ?? [];
            byProduct.set(entry.productKey, [...bucket, entry]);
        }

        return [...byProduct].map(([productKey, rows]) => {
            // Newest first. createdAt breaks ties when two entries share a date.
            const sorted = [...rows].sort((a, b) =>
                compareDesc(a.purchaseDate, b.purchaseDate) || (b.createdAt - a.createdAt));

            const prices = sorted.map(r => r.unitPrice);
            const [latest, previous] = sorted;
            const recent = prices.slice(0, 3);
            const avg3 = recent.reduce((sum, p) => sum + p, 0) / recent.length;
            const cheapest = sorted.reduce((best, r) => r.unitPrice < best.unitPrice ? r : best);

            return {
                productKey,
                productName: latest.productName,
                category: latest.category,
                unit: latest.unit,
                latest: latest.unitPrice,
                latestDate: latest.purchaseDate,
                latestStore: latest.store,
                previous: previous?.unitPrice ?? null,
                deltaPct: previous
                    ? ((latest.unitPrice - previous.unitPrice) / previous.unitPrice) * 100
                    : null,
                min: Math.min(...prices),
                max: Math.max(...prices),
                avg3,
                cheapestStore: cheapest.store,
                count: sorted.length,
                sparkline: prices.slice(0, 12).reverse(),
            };
        }).sort((a, b) => compareDesc(a.latestDate, b.latestDate));
    }

    /** Price stats for one product, or null when never bought. */
    function lastEntryFor(productKey) {
        if (!productKey) return null;
        const rows = purchases.filter(p => p.productKey === productKey);
        return rows.length ? priceHistory(rows)[0] : null;
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
        dateInput.value = todayStr();
        addItemRow();
        bindEvents();
        initNavigation();
        registerServiceWorker();
        initAuth();
        if (new URLSearchParams(location.search).has('selfcheck')) selfCheck();
    }

    // ═══════════════════════════════════════════════════════
    //  ITEM ROWS
    // ═══════════════════════════════════════════════════════
    function addItemRow(values = null) {
        const row = rowTemplate.content.firstElementChild.cloneNode(true);

        if (values) {
            row.querySelector('.row-product').value = values.productName || '';
            row.querySelector('.row-category').value = values.category || '';
            row.querySelector('.row-unit').value = values.unit || '';
            row.querySelector('.row-price').value = values.unitPrice ?? '';
        }

        row.querySelector('.row-product').addEventListener('input', () => onProductChange(row));
        row.querySelector('.row-product').addEventListener('change', () => onProductChange(row));
        row.querySelector('.row-price').addEventListener('input', updateTotalPreview);
        row.querySelector('.row-remove').addEventListener('click', () => removeItemRow(row));

        itemRows.appendChild(row);
        refreshRowChrome();
        return row;
    }

    function removeItemRow(row) {
        // Never leave the form with nothing to fill in.
        if (itemRows.children.length === 1) {
            clearRow(row);
        } else {
            row.remove();
        }
        refreshRowChrome();
        updateTotalPreview();
    }

    function clearRow(row) {
        row.querySelectorAll('input').forEach(i => { i.value = ''; });
        row.querySelector('.row-hint').classList.add('hidden');
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

    function onProductChange(row) {
        const hint = row.querySelector('.row-hint');
        const last = lastEntryFor(slug(row.querySelector('.row-product').value));

        if (!last) {
            hint.classList.add('hidden');
            return;
        }

        // Only prefill blanks — never clobber something already typed.
        const categoryEl = row.querySelector('.row-category');
        const unitEl = row.querySelector('.row-unit');
        if (!categoryEl.value) categoryEl.value = last.category;
        if (!unitEl.value) unitEl.value = last.unit;

        hint.innerHTML = `Last <strong>₹${fmt(last.latest)}</strong>`
            + (last.unit ? ` / ${escapeHtml(last.unit)}` : '')
            + ` · ${formatDatePretty(last.latestDate)}`
            + (last.latestStore ? ` · ${escapeHtml(last.latestStore)}` : '')
            + ` · best ₹${fmt(last.min)} · avg3 ₹${fmt(last.avg3)}`;
        hint.classList.remove('hidden');
    }

    function updateTotalPreview() {
        const rows = [...itemRows.children].map(readRow);
        const filled = rows.filter(r => parseFloat(r.price) > 0);
        const total = filled.reduce((sum, r) => sum + parseFloat(r.price), 0);
        totalPreview.textContent = filled.length
            ? `${filled.length} item${filled.length > 1 ? 's' : ''} · ₹${fmt(total)}`
            : '';
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

        const titles = { log: 'Log', prices: 'Price History' };
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
            searchTerm = e.target.value.toLowerCase().trim();
            renderPrices();
        });

        filterBar.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-cat]');
            if (!btn) return;
            activeCategory = btn.dataset.cat;
            $$('#invFilters .filter-pill').forEach(p =>
                p.classList.toggle('active', p.dataset.cat === activeCategory));
            renderPrices();
        });

        if (sidebarLoginBtn) sidebarLoginBtn.addEventListener('click', handleLoginClick);
        if (mobileLoginBtn) mobileLoginBtn.addEventListener('click', handleLoginClick);
    }

    // ═══════════════════════════════════════════════════════
    //  SAVE
    // ═══════════════════════════════════════════════════════
    function handleSubmit(e) {
        e.preventDefault();

        if (!dateInput.value) return showToast('Purchase date required');

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
        const unitPrice = parseFloat(row.price);

        return {
            id: editingId || generateId(),
            purchaseDate: dateInput.value,
            productKey: slug(row.productName),
            productName: row.productName,
            category: normaliseLabel(row.category),
            unit: row.unit,
            quantity: FIXED_QUANTITY,
            unitPrice,
            totalPrice: unitPrice * FIXED_QUANTITY,
            store: storeInput.value.trim(),
            notes: '',
            createdAt: existing?.createdAt ?? Date.now(),
        };
    }

    /** Message describing a suspicious price, or null when it looks normal. */
    function oddPrice(entry) {
        const last = lastEntryFor(entry.productKey);
        if (!last) return null;
        const tooHigh = entry.unitPrice > last.latest * PRICE_SANITY_FACTOR;
        const tooLow = entry.unitPrice < last.latest / PRICE_SANITY_FACTOR;
        if (!tooHigh && !tooLow) return null;
        return `${entry.productName} ₹${fmt(entry.unitPrice)} vs last ₹${fmt(last.latest)}`;
    }

    async function commit(entries) {
        // Capture the comparison before the new rows land in `purchases`.
        const previous = entries.map(e => lastEntryFor(e.productKey));
        const wasEditing = Boolean(editingId);

        try {
            await persistAll(entries);
        } catch (err) {
            console.error('Save failed:', err);
            showToast(err.code === 'permission-denied'
                ? 'Save blocked by Firestore rules — allow users/{uid}/purchases'
                : 'Save failed: ' + err.message);
            return;
        }

        showToast(saveMessage(entries, previous, wasEditing));
        resetForm();
        itemRows.querySelector('.row-product').focus();
    }

    function saveMessage(entries, previous, wasEditing) {
        if (wasEditing) return 'Entry updated';

        if (entries.length === 1) {
            const [entry] = entries;
            const [last] = previous;
            if (!last) return `${entry.productName} logged — first entry`;
            const delta = ((entry.unitPrice - last.latest) / last.latest) * 100;
            const dir = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat vs';
            return `${entry.productName} ₹${fmt(entry.unitPrice)} — ${dir} ${Math.abs(delta).toFixed(1)}% from ₹${fmt(last.latest)}`;
        }

        const total = entries.reduce((sum, e) => sum + e.totalPrice, 0);
        return `${entries.length} items saved · ₹${fmt(total)}`;
    }

    function startEdit(id) {
        const entry = purchases.find(p => p.id === id);
        if (!entry) return;

        editingId = id;
        editIdInput.value = id;
        storeInput.value = entry.store || '';
        dateInput.value = entry.purchaseDate;

        // Editing touches exactly one entry, so collapse to a single row.
        itemRows.innerHTML = '';
        addItemRow(entry);
        addItemBtn.classList.add('hidden');
        cancelEditBtn.classList.remove('hidden');
        refreshRowChrome();
        updateTotalPreview();

        navigate('log');
        form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function resetForm() {
        editingId = null;
        editIdInput.value = '';
        storeInput.value = '';
        dateInput.value = todayStr();
        itemRows.innerHTML = '';
        addItemRow();
        addItemBtn.classList.remove('hidden');
        cancelEditBtn.classList.add('hidden');
        refreshRowChrome();
        updateTotalPreview();
    }

    // ═══════════════════════════════════════════════════════
    //  RENDER
    // ═══════════════════════════════════════════════════════
    function render() {
        renderDatalists();
        renderFilters();
        renderStats();
        renderLog();
        renderPrices();
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
        // Rebuilding drops the active pill when its category disappears.
        if (!categories.includes(activeCategory)) activeCategory = 'All';

        filterBar.innerHTML = categories.map(c =>
            `<button type="button" data-cat="${escapeHtml(c)}" class="filter-pill ${c === activeCategory ? 'active' : ''} px-md py-xs rounded-full text-[11px] font-bold uppercase tracking-wider whitespace-nowrap">${escapeHtml(c)}</button>`
        ).join('');
    }

    function renderStats() {
        const month = todayStr().slice(0, 7);
        const monthSpend = purchases
            .filter(p => String(p.purchaseDate || '').startsWith(month))
            .reduce((sum, p) => sum + (p.totalPrice || 0), 0);

        statProducts.textContent = new Set(purchases.map(p => p.productKey)).size;
        statEntries.textContent = purchases.length;
        statMonth.textContent = '₹' + fmt(monthSpend);
    }

    function renderLog() {
        const recent = [...purchases]
            .sort((a, b) => compareDesc(a.purchaseDate, b.purchaseDate) || (b.createdAt - a.createdAt))
            .slice(0, RECENT_LIMIT);

        logEmpty.classList.toggle('hidden', recent.length > 0);
        logList.innerHTML = recent.map(p => `
            <div class="ticket-card p-md flex items-center justify-between gap-md">
                <div class="flex flex-col gap-1 min-w-0">
                    <span class="text-sm font-bold text-on-surface truncate">${escapeHtml(p.productName)}</span>
                    <span class="text-[10px] font-bold text-on-surface-variant uppercase tracking-widest">
                        ${escapeHtml(p.category)} · ${formatDatePretty(p.purchaseDate)}${p.store ? ' · ' + escapeHtml(p.store) : ''}
                    </span>
                </div>
                <div class="flex items-center gap-md shrink-0">
                    <div class="flex flex-col items-end gap-1">
                        <span class="text-base font-bold text-on-surface">₹${fmt(p.unitPrice)}</span>
                        <span class="text-[10px] font-bold text-on-surface-variant uppercase tracking-widest">${escapeHtml(p.unit)}</span>
                    </div>
                    <div class="flex gap-xs">
                        <button data-edit="${p.id}" class="p-xs text-on-surface-variant hover:text-primary transition-colors" aria-label="Edit ${escapeHtml(p.productName)}">
                            <span class="material-symbols-outlined text-[20px]">edit</span>
                        </button>
                        <button data-del="${p.id}" class="p-xs text-on-surface-variant hover:text-error transition-colors" aria-label="Delete ${escapeHtml(p.productName)}">
                            <span class="material-symbols-outlined text-[20px]">delete</span>
                        </button>
                    </div>
                </div>
            </div>`).join('');

        logList.querySelectorAll('[data-edit]').forEach(btn =>
            btn.addEventListener('click', () => startEdit(btn.dataset.edit)));
        logList.querySelectorAll('[data-del]').forEach(btn =>
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

    function renderPrices() {
        const rows = priceHistory(purchases).filter(r =>
            (activeCategory === 'All' || r.category === activeCategory) &&
            (!searchTerm || r.productName.toLowerCase().includes(searchTerm)));

        priceEmpty.classList.toggle('hidden', rows.length > 0);
        priceList.innerHTML = rows.map(r => {
            const delta = r.deltaPct === null ? '' : `
                <span class="text-[11px] font-bold ${r.deltaPct > 0 ? 'text-error' : 'text-secondary'}">
                    ${r.deltaPct > 0 ? '▲' : r.deltaPct < 0 ? '▼' : '—'} ${Math.abs(r.deltaPct).toFixed(1)}%
                </span>`;
            return `
            <div class="ticket-card p-md flex flex-col gap-sm">
                <div class="flex items-start justify-between gap-md">
                    <div class="flex flex-col gap-1 min-w-0">
                        <span class="text-sm font-bold text-on-surface truncate">${escapeHtml(r.productName)}</span>
                        <span class="text-[10px] font-bold text-on-surface-variant uppercase tracking-widest">${escapeHtml(r.category)} · ${escapeHtml(r.unit)} · ${r.count} ${r.count === 1 ? 'entry' : 'entries'}</span>
                    </div>
                    <div class="flex items-center gap-sm shrink-0">
                        <span class="text-on-surface-variant">${sparkline(r.sparkline)}</span>
                        <div class="flex flex-col items-end gap-1">
                            <span class="text-base font-bold text-on-surface">₹${fmt(r.latest)}</span>
                            ${delta}
                        </div>
                    </div>
                </div>
                <div class="w-full border-b border-dashed border-outline-variant"></div>
                <div class="flex flex-wrap gap-x-md gap-y-1 text-[10px] font-bold text-on-surface-variant uppercase tracking-widest">
                    <span>Range ₹${fmt(r.min)}–₹${fmt(r.max)}</span>
                    <span>Avg3 ₹${fmt(r.avg3)}</span>
                    ${r.cheapestStore ? `<span>Best ${escapeHtml(r.cheapestStore)}</span>` : ''}
                    <span class="ml-auto normal-case tracking-normal">Last bought ${formatDatePretty(r.latestDate)} at ₹${fmt(r.latest)}</span>
                </div>
            </div>`;
        }).join('');
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

    function todayStr() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function formatDatePretty(dateStr) {
        if (!dateStr) return '—';
        const [, m, d] = String(dateStr).split('-').map(Number);
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        return `${d} ${months[m - 1] || ''}`.trim();
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

    function registerServiceWorker() {
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('service-worker.js')
                .catch(err => console.warn('SW registration failed:', err));
        }
    }

    // ponytail: one self-check, covers the ways the pure logic actually breaks.
    // Run inventory.html?selfcheck=1 and watch the console.
    function selfCheck() {
        const rows = [
            { productKey: 'milk', productName: 'Milk', category: 'Dairy', unit: '1L',
              unitPrice: 30, purchaseDate: '2026-08-12', createdAt: 1, store: 'DMart' },
            { productKey: 'milk', productName: 'Milk', category: 'Dairy', unit: '1L',
              unitPrice: 32, purchaseDate: '2026-08-28', createdAt: 2, store: 'Local' },
            { productKey: 'rice', productName: 'Rice', category: 'Grains', unit: '5kg',
              unitPrice: 60, purchaseDate: '2026-08-05', createdAt: 3, store: 'DMart' },
        ];
        const out = priceHistory(rows);
        const milk = out.find(r => r.productKey === 'milk');
        const rice = out.find(r => r.productKey === 'rice');

        console.assert(milk.latest === 32, 'newest entry must win regardless of input order');
        console.assert(Math.abs(milk.deltaPct - 6.667) < 0.01, 'delta% wrong');
        console.assert(milk.cheapestStore === 'DMart', 'cheapest store wrong');
        console.assert(milk.min === 30 && milk.max === 32, 'range wrong');
        console.assert(rice.deltaPct === null, 'single entry must not divide by zero');
        console.assert(slug('  Amul  Milk!! ') === 'amul-milk', 'slug normalisation wrong');
        console.assert(normaliseLabel('  dry   fruits ') === 'Dry Fruits', 'label normalisation wrong');
        console.log('inventory self-check done');
    }

    init();
