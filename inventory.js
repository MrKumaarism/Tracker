import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { getFirestore, collection, doc, setDoc, deleteDoc, onSnapshot, enableIndexedDbPersistence } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

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
    const CATEGORIES = ['Produce', 'Dairy', 'Grains', 'Meat', 'Pantry', 'Frozen',
                        'Beverages', 'Household', 'Personal Care', 'Other'];
    const UNITS = ['kg', 'g', 'L', 'ml', 'piece', 'pack'];
    // Warn (never block) when a price is wildly off the last one — usually a wrong unit.
    const PRICE_SANITY_FACTOR = 2;
    const RECENT_LIMIT = 30;

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
    const productInput  = $('#invProduct');
    const categorySel   = $('#invCategory');
    const qtyInput      = $('#invQty');
    const unitSel       = $('#invUnit');
    const priceInput    = $('#invPrice');
    const storeInput    = $('#invStore');
    const dateInput     = $('#invDate');
    const notesInput    = $('#invNotes');
    const submitText    = $('#invSubmitText');
    const cancelEditBtn = $('#invCancelEdit');
    const lastPriceHint = $('#lastPriceHint');
    const totalPreview  = $('#invTotalPreview');
    const productList   = $('#productList');
    const logList       = $('#logList');
    const logEmpty      = $('#logEmpty');
    const priceList     = $('#priceList');
    const priceEmpty    = $('#priceEmpty');
    const searchInput   = $('#invSearch');
    const filterBar     = $('#invFilters');
    const dateRow       = $('#dateRow');
    const statProducts  = $('#stat-products');
    const statEntries   = $('#stat-entries');
    const statMonth     = $('#stat-month');
    const sidebarLoginBtn = $('#sidebarLoginBtn');
    const mobileLoginBtn  = $('#mobileLoginBtn');

    // ═══════════════════════════════════════════════════════
    //  PURE LOGIC
    // ═══════════════════════════════════════════════════════

    /** Normalise a typed product name so spelling/case variants group together. */
    function slug(name) {
        return String(name).toLowerCase().trim()
            .replace(/[^a-z0-9\s]/g, '')
            .replace(/\s+/g, '-');
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

    /** ISO date strings sort lexicographically — newest first. */
    function compareDesc(a, b) {
        return a < b ? 1 : a > b ? -1 : 0;
    }

    /** Price stats for one product, or null when never bought. */
    function lastEntryFor(productKey) {
        if (!productKey) return null;
        const rows = purchases.filter(p => p.productKey === productKey);
        return rows.length ? priceHistory(rows)[0] : null;
    }

    // ═══════════════════════════════════════════════════════
    //  INIT
    // ═══════════════════════════════════════════════════════
    function init() {
        buildSelects();
        buildFilters();
        dateInput.value = todayStr();
        bindEvents();
        initNavigation();
        registerServiceWorker();
        initAuth();
        if (new URLSearchParams(location.search).has('selfcheck')) selfCheck();
    }

    function buildSelects() {
        categorySel.innerHTML = CATEGORIES.map(c => `<option value="${c}">${c}</option>`).join('');
        unitSel.innerHTML = UNITS.map(u => `<option value="${u}">${u}</option>`).join('');
    }

    function buildFilters() {
        filterBar.innerHTML = ['All', ...CATEGORIES].map(c =>
            `<button type="button" data-cat="${c}" class="filter-pill ${c === 'All' ? 'active' : ''} px-md py-xs rounded-full text-[11px] font-bold uppercase tracking-wider whitespace-nowrap">${c}</button>`
        ).join('');
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
            showToast('Sync error — showing local data');
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

    async function persist(entry) {
        if (currentUser) {
            await setDoc(doc(purchasesRef(), entry.id), entry);
            return;
        }
        purchases = [...purchases.filter(p => p.id !== entry.id), entry];
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

        // Autocomplete recall: prefill category/unit from the last buy of this product.
        productInput.addEventListener('input', onProductChange);
        productInput.addEventListener('change', onProductChange);

        qtyInput.addEventListener('input', updateTotalPreview);
        priceInput.addEventListener('input', updateTotalPreview);

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

        $('#toggleDate').addEventListener('click', () => dateRow.classList.toggle('hidden'));

        if (sidebarLoginBtn) sidebarLoginBtn.addEventListener('click', handleLoginClick);
        if (mobileLoginBtn) mobileLoginBtn.addEventListener('click', handleLoginClick);
    }

    function onProductChange() {
        const last = lastEntryFor(slug(productInput.value));
        if (!last) {
            lastPriceHint.classList.add('hidden');
            return;
        }
        // Only prefill while adding — never overwrite fields mid-edit.
        if (!editingId) {
            categorySel.value = last.category;
            unitSel.value = last.unit;
        }
        lastPriceHint.innerHTML = `Last <strong>₹${fmt(last.latest)}/${escapeHtml(last.unit)}</strong>`
            + ` · ${formatDatePretty(last.latestDate)}`
            + (last.latestStore ? ` · ${escapeHtml(last.latestStore)}` : '')
            + ` · best ₹${fmt(last.min)} · avg3 ₹${fmt(last.avg3)}`;
        lastPriceHint.classList.remove('hidden');
        updateTotalPreview();
    }

    function updateTotalPreview() {
        const qty = parseFloat(qtyInput.value);
        const price = parseFloat(priceInput.value);
        totalPreview.textContent = (qty > 0 && price > 0) ? `Total ₹${fmt(qty * price)}` : '';
    }

    function handleSubmit(e) {
        e.preventDefault();

        const productName = productInput.value.trim();
        const quantity = parseFloat(qtyInput.value);
        const unitPrice = parseFloat(priceInput.value);

        // Validate at the boundary: a zero here poisons every average downstream.
        if (!productName) return showToast('Product name required');
        if (!(quantity > 0)) return showToast('Quantity must be greater than 0');
        if (!(unitPrice > 0)) return showToast('Price must be greater than 0');
        if (!dateInput.value) return showToast('Purchase date required');

        const productKey = slug(productName);
        const last = editingId ? null : lastEntryFor(productKey);
        const wayOff = last && (unitPrice > last.latest * PRICE_SANITY_FACTOR
                             || unitPrice < last.latest / PRICE_SANITY_FACTOR);

        if (wayOff) {
            showConfirm(
                `₹${fmt(unitPrice)}/${unitSel.value} is far off the last ₹${fmt(last.latest)}/${last.unit}. Wrong unit? Save anyway?`,
                () => saveEntry(productName, productKey, quantity, unitPrice, last)
            );
            return;
        }

        saveEntry(productName, productKey, quantity, unitPrice, last);
    }

    async function saveEntry(productName, productKey, quantity, unitPrice, last) {
        const existing = editingId ? purchases.find(p => p.id === editingId) : null;
        const wasEditing = Boolean(editingId);

        const entry = {
            id: editingId || generateId(),
            purchaseDate: dateInput.value,
            productKey,
            productName,
            category: categorySel.value,
            unit: unitSel.value,
            quantity,
            unitPrice,
            totalPrice: +(quantity * unitPrice).toFixed(2),
            store: storeInput.value.trim(),
            notes: notesInput.value.trim(),
            createdAt: existing?.createdAt ?? Date.now(),
        };

        try {
            await persist(entry);
        } catch (err) {
            console.error('Save failed:', err);
            showToast('Save failed: ' + err.message);
            return;
        }

        if (wasEditing) {
            showToast('Entry updated');
        } else if (last) {
            const delta = ((unitPrice - last.latest) / last.latest) * 100;
            const dir = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat vs';
            showToast(`${productName} ₹${fmt(unitPrice)}/${entry.unit} — ${dir} ${Math.abs(delta).toFixed(1)}% from ₹${fmt(last.latest)}`);
        } else {
            showToast(`${productName} logged — first entry`);
        }

        resetForm();
        productInput.focus(); // Sheet stays open: one trip is many items.
    }

    function startEdit(id) {
        const entry = purchases.find(p => p.id === id);
        if (!entry) return;

        editingId = id;
        editIdInput.value = id;
        productInput.value = entry.productName;
        categorySel.value = entry.category;
        qtyInput.value = entry.quantity;
        unitSel.value = entry.unit;
        priceInput.value = entry.unitPrice;
        storeInput.value = entry.store || '';
        notesInput.value = entry.notes || '';
        dateInput.value = entry.purchaseDate;

        dateRow.classList.remove('hidden');
        submitText.textContent = 'Update';
        cancelEditBtn.classList.remove('hidden');
        lastPriceHint.classList.add('hidden');
        updateTotalPreview();
        navigate('log');
        form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function resetForm() {
        editingId = null;
        form.reset();
        editIdInput.value = '';
        dateInput.value = todayStr();
        dateRow.classList.add('hidden');
        submitText.textContent = 'Save';
        cancelEditBtn.classList.add('hidden');
        lastPriceHint.classList.add('hidden');
        totalPreview.textContent = '';
    }

    // ═══════════════════════════════════════════════════════
    //  RENDER
    // ═══════════════════════════════════════════════════════
    function render() {
        renderDatalist();
        renderStats();
        renderLog();
        renderPrices();
    }

    function renderDatalist() {
        const seen = new Map();
        for (const p of purchases) seen.set(p.productKey, p.productName);
        productList.innerHTML = [...seen.values()]
            .sort((a, b) => a.localeCompare(b))
            .map(n => `<option value="${escapeHtml(n)}"></option>`).join('');
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
                        <span class="text-base font-bold text-on-surface">₹${fmt(p.unitPrice)}<span class="text-[10px] text-on-surface-variant">/${escapeHtml(p.unit)}</span></span>
                        <span class="text-[10px] font-bold text-on-surface-variant uppercase tracking-widest">${fmt(p.quantity)} ${escapeHtml(p.unit)} · ₹${fmt(p.totalPrice)}</span>
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
                        <span class="text-[10px] font-bold text-on-surface-variant uppercase tracking-widest">${escapeHtml(r.category)} · ${r.count} ${r.count === 1 ? 'entry' : 'entries'}</span>
                    </div>
                    <div class="flex items-center gap-sm shrink-0">
                        <span class="text-on-surface-variant">${sparkline(r.sparkline)}</span>
                        <div class="flex flex-col items-end gap-1">
                            <span class="text-base font-bold text-on-surface">₹${fmt(r.latest)}<span class="text-[10px] text-on-surface-variant">/${escapeHtml(r.unit)}</span></span>
                            ${delta}
                        </div>
                    </div>
                </div>
                <div class="w-full border-b border-dashed border-outline-variant"></div>
                <div class="flex flex-wrap gap-x-md gap-y-1 text-[10px] font-bold text-on-surface-variant uppercase tracking-widest">
                    <span>Range ₹${fmt(r.min)}–₹${fmt(r.max)}</span>
                    <span>Avg3 ₹${fmt(r.avg3)}</span>
                    ${r.cheapestStore ? `<span>Best ${escapeHtml(r.cheapestStore)}</span>` : ''}
                    <span class="ml-auto normal-case tracking-normal">Last bought ${formatDatePretty(r.latestDate)} at ₹${fmt(r.latest)}/${escapeHtml(r.unit)}</span>
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
        toast._timer = setTimeout(() => toast.classList.remove('toast-show'), 2600);
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

    // ponytail: one self-check, covers the ways priceHistory actually breaks.
    // Run inventory.html?selfcheck=1 and watch the console.
    function selfCheck() {
        const rows = [
            { productKey: 'milk', productName: 'Milk', category: 'Dairy', unit: 'L',
              unitPrice: 30, purchaseDate: '2026-08-12', createdAt: 1, store: 'DMart' },
            { productKey: 'milk', productName: 'Milk', category: 'Dairy', unit: 'L',
              unitPrice: 32, purchaseDate: '2026-08-28', createdAt: 2, store: 'Local' },
            { productKey: 'rice', productName: 'Rice', category: 'Grains', unit: 'kg',
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
        console.log('inventory self-check done');
    }

    init();
