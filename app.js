import { initializeApp } from "./vendor/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "./vendor/firebase-auth.js";
import { getFirestore, collection, doc, setDoc, deleteDoc, onSnapshot, enableIndexedDbPersistence } from "./vendor/firebase-firestore.js";

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
   Fuel Tracker — Application Logic
   Firebase Firestore | CRUD | Export/Import | PWA
   ═══════════════════════════════════════════════════════ */
    // ─── Constants ───
    const DB_NAME = 'FuelTrackerDB';
    const DB_VERSION = 1;
    const STORE_NAME = 'entries';
    const LS_KEY = 'fuel_tracker_entries';

    // ─── State ───
    let db = null;
    let entries = [];
    let editingId = null;
    let useIndexedDB = false;
    let currentUser = null;
    let unsubscribeSnapshot = null;
    let activeFilter = 'All';

    // ─── DOM Helpers ───
    const $ = (s) => document.querySelector(s);
    const $$ = (s) => document.querySelectorAll(s);

    // ─── DOM Refs ───
    const fuelForm       = $('#fuelForm');
    const editIdInput    = $('#editId');
    const kmInput        = $('#kmDriven');
    const priceInput     = $('#fuelPrice');
    const spentInput     = $('#amountSpent');
    const dateInput      = $('#entryDate');
    const liveMileage    = $('#live-mileage');
    const liveCostPerKm  = $('#live-cost-per-km');
    const priceUnitLabel = $('#fuel-price-unit-label');
    const estUnitLabel   = $('#est-unit-label');
    const submitBtn      = $('#submitBtn');
    const submitBtnText  = $('#submitBtnText');
    const cancelEditBtn  = $('#cancelEditBtn');
    const formHeadingText = $('#formHeadingText');
    const formIconEl     = $('#formIconEl');

    // Stats
    const statTotalKm      = $('#stat-total-km');
    const statTotalEntries  = $('#stat-total-entries');
    const statTotalSpent    = $('#stat-total-spent');
    const statOverallAvg    = $('#stat-overall-avg');
    const statAvgUnit       = $('#stat-avg-unit');
    const statMonthSpent    = $('#stat-month-spent');
    const totalLogsCounter  = $('#total-logs-counter');
    const dataEntryCount    = $('#data-entry-count');
    const dataStorageType   = $('#data-storage-type');

    // Progress bars
    const barKm      = $('#bar-km');
    const barEntries = $('#bar-entries');
    const barAvg     = $('#bar-avg');
    const barMonth   = $('#bar-month');

    // History
    const historyList      = $('#history-list');
    const historyEmpty     = $('#history-empty-state');
    const historySearch    = $('#historySearch');
    const historyFilters   = $('#historyFilters');
    const emptyAddBtn      = $('#emptyAddBtn');
    const cardTemplate     = $('#log-card-template');

    // Data management
    const exportJsonBtn  = $('#exportJsonBtn');
    const exportCsvBtn   = $('#exportCsvBtn');
    const importFile     = $('#importFile');
    const clearBtn       = $('#clearBtn');

    // Toast & Confirm
    const toastEl        = $('#toast');
    const confirmOverlay = $('#confirmOverlay');
    const confirmMessage = $('#confirmMessage');
    const confirmYes     = $('#confirmYes');
    const confirmNo      = $('#confirmNo');
    
    // Auth DOM Refs
    const sidebarLoginBtn = $('#sidebarLoginBtn');
    const sidebarLoginText = $('#sidebarLoginText');
    const mobileLoginBtn = $('#mobileLoginBtn');
    const mobileLoginText = $('#mobileLoginText');

    // ═══════════════════════════════════════════════════════
    //  INIT
    // ═══════════════════════════════════════════════════════
    async function init() {
        setDefaultDate();
        bindEvents();
        initNavigation();

        // Initialize Firebase Auth which will load data
        initAuth();
    }

    function setDefaultDate() {
        const today = new Date();
        const yyyy = today.getFullYear();
        const mm = String(today.getMonth() + 1).padStart(2, '0');
        const dd = String(today.getDate()).padStart(2, '0');
        dateInput.value = `${yyyy}-${mm}-${dd}`;
    }

    // ─── Migrate old entry format ───
    function migrateEntries() {
        let changed = false;
        entries = entries.map(e => {
            // Old format used 'cost' instead of 'spent'
            if (e.cost !== undefined && e.spent === undefined) {
                e.spent = e.cost;
                delete e.cost;
                changed = true;
            }
            // Ensure spent is a valid number
            if (typeof e.spent !== 'number' || isNaN(e.spent)) e.spent = 0;
            if (typeof e.km !== 'number' || isNaN(e.km)) e.km = 0;
            // Derive missing fields
            if (!e.price && e.spent && e.qty) e.price = +(e.spent / e.qty).toFixed(2);
            if (!e.price) e.price = e.fuelType === 'CNG' ? 83 : 102;
            if (!e.qty && e.price > 0) e.qty = +(e.spent / e.price).toFixed(3);
            if (!e.unit) e.unit = e.fuelType === 'CNG' ? 'km/kg' : 'km/L';
            if (!e.createdAt) e.createdAt = Date.now();
            if (!e.updatedAt) e.updatedAt = Date.now();
            if (e.tripEntered === undefined) {
                e.tripEntered = e.km;
            }
            return e;
        });
        
        recalculateChainsLocal();
    }

    // ═══════════════════════════════════════════════════════
    // ═══════════════════════════════════════════════════════
    //  FIREBASE FIRESTORE & AUTH
    // ═══════════════════════════════════════════════════════
    
    function initAuth() {
        onAuthStateChanged(auth, (user) => {
            currentUser = user;
            updateAuthUI();
            if (user) {
                // Logged in: load from Firestore
                loadFirestoreData();
            } else {
                // Logged out: fallback to local storage
                if (unsubscribeSnapshot) unsubscribeSnapshot();
                entries = loadFromLocalStorage();
                render();
            }
        });
    }

    function updateAuthUI() {
        if (currentUser) {
            if (sidebarLoginText) sidebarLoginText.textContent = 'Logout';
            if (mobileLoginText) mobileLoginText.textContent = 'Logout';
            if ($('#sidebarLoginIcon')) $('#sidebarLoginIcon').textContent = 'logout';
            if ($('#mobileLoginIcon')) $('#mobileLoginIcon').textContent = 'logout';
        } else {
            if (sidebarLoginText) sidebarLoginText.textContent = 'Sign in with Google';
            if (mobileLoginText) mobileLoginText.textContent = 'Google Login';
            if ($('#sidebarLoginIcon')) $('#sidebarLoginIcon').textContent = 'login';
            if ($('#mobileLoginIcon')) $('#mobileLoginIcon').textContent = 'login';
        }
    }

    async function handleLoginClick() {
        if (currentUser) {
            await signOut(auth);
            showToast('Logged out');
        } else {
            const provider = new GoogleAuthProvider();
            try {
                await signInWithPopup(auth, provider);
                showToast('Logged in successfully');
            } catch (err) {
                showToast('Login failed: ' + err.message);
            }
        }
    }

    function loadFirestoreData() {
        if (!currentUser) return;
        const entriesRef = collection(dbFirestore, 'users', currentUser.uid, 'entries');
        
        if (unsubscribeSnapshot) unsubscribeSnapshot();
        
        unsubscribeSnapshot = onSnapshot(entriesRef, (snapshot) => {
            const serverEntries = [];
            snapshot.forEach((doc) => {
                serverEntries.push(doc.data());
            });
            entries = serverEntries;
            saveToLocalStorage(); // Backup
            migrateEntries();
            render();
        }, (error) => {
            console.error("Error listening to Firestore:", error);
            showToast("Sync error. Working offline.");
        });
    }

    async function putEntryFirestore(entry) {
        if (!currentUser) return;
        const entryRef = doc(dbFirestore, 'users', currentUser.uid, 'entries', entry.id);
        await setDoc(entryRef, entry);
    }

    async function deleteEntryFirestore(id) {
        if (!currentUser) return;
        const entryRef = doc(dbFirestore, 'users', currentUser.uid, 'entries', id);
        await deleteDoc(entryRef);
    }

    async function clearFirestore() {
        if (!currentUser) return;
        entries.forEach(async (entry) => {
            await deleteEntryFirestore(entry.id);
        });
    }

    // ─── localStorage fallback ───
    function loadFromLocalStorage() {
        try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; }
        catch { return []; }
    }
    function saveToLocalStorage() {
        localStorage.setItem(LS_KEY, JSON.stringify(entries));
    }
    
    function recalculateChainsLocal() {
        const groups = {};
        entries.forEach(e => {
            const key = e.vehicleType + '_' + e.fuelType;
            if (!groups[key]) groups[key] = [];
            groups[key].push(e);
        });

        const updatedEntries = [];

        for (const key in groups) {
            const group = groups[key];
            group.sort((a, b) => {
                const dc = a.date.localeCompare(b.date);
                return dc !== 0 ? dc : a.createdAt - b.createdAt;
            });

            for (let i = 0; i < group.length; i++) {
                const entry = group[i];
                entry.qty = +(entry.spent / entry.price).toFixed(3);
                
                if (i + 1 < group.length) {
                    const nextEntry = group[i + 1];
                    entry.distanceDriven = nextEntry.tripEntered || 0;
                    if (entry.qty > 0 && entry.distanceDriven > 0) {
                        entry.mileage = +(entry.distanceDriven / entry.qty).toFixed(2);
                        entry.costPerKm = +(entry.spent / entry.distanceDriven).toFixed(2);
                    } else {
                        entry.mileage = null;
                        entry.costPerKm = null;
                    }
                    entry.status = 'completed';
                } else {
                    entry.distanceDriven = null;
                    entry.mileage = null;
                    entry.costPerKm = null;
                    entry.status = 'pending';
                }
                updatedEntries.push(entry);
            }
        }
        entries = updatedEntries;
        saveToLocalStorage();
    }
    
    async function recalculateAndSyncChains() {
        recalculateChainsLocal();
        if (currentUser) {
            for (const entry of entries) {
                try { await putEntryFirestore(entry); } catch(e) {}
            }
        }
        saveToLocalStorage();
    }

    // ═══════════════════════════════════════════════════════
    //  NAVIGATION
    // ═══════════════════════════════════════════════════════
    function initNavigation() {
        // Sidebar links
        $$('.nav-link').forEach(link => {
            link.addEventListener('click', () => navigate(link.dataset.page));
        });
        // Bottom nav links
        $$('.bottom-nav-link').forEach(link => {
            link.addEventListener('click', () => navigate(link.dataset.page));
        });
    }

    function navigate(page) {
        // Hide all pages
        $$('.page-section').forEach(s => s.classList.add('hidden'));
        // Show target page
        const target = $(`#page-${page}`);
        if (target) {
            target.classList.remove('hidden');
            // Re-trigger animation
            target.style.animation = 'none';
            target.offsetHeight; // reflow
            target.style.animation = '';
        }

        // Update sidebar active
        $$('.nav-link').forEach(l => l.classList.toggle('active', l.dataset.page === page));
        // Update bottom nav active
        $$('.bottom-nav-link').forEach(l => l.classList.toggle('active', l.dataset.page === page));

        // Update header title
        const titles = { dashboard: 'Dashboard', history: 'History', data: 'Data' };
        const headerTitle = $('#headerPageTitle');
        if (headerTitle) headerTitle.textContent = titles[page] || '';

        // Scroll to top
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // ═══════════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════════
    function bindEvents() {
        fuelForm.addEventListener('submit', handleSubmit);
        cancelEditBtn.addEventListener('click', cancelEdit);

        if (sidebarLoginBtn) sidebarLoginBtn.addEventListener('click', handleLoginClick);
        if (mobileLoginBtn) mobileLoginBtn.addEventListener('click', handleLoginClick);

        // Live calculation
        kmInput.addEventListener('input', calculateLive);
        priceInput.addEventListener('input', calculateLive);
        spentInput.addEventListener('input', calculateLive);
        dateInput.addEventListener('change', calculateLive);

        // Fuel type change → update unit labels + default price
        $$('input[name="fuelType"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                const isPetrol = e.target.value === 'Petrol';
                priceUnitLabel.textContent = isPetrol ? '₹/L' : '₹/kg';
                priceInput.value = isPetrol ? '102' : '83';
                calculateLive();
            });
        });
        
        $$('input[name="vehicleType"]').forEach(radio => {
            radio.addEventListener('change', calculateLive);
        });

        // History filters
        historyFilters.addEventListener('click', (e) => {
            const pill = e.target.closest('.filter-pill');
            if (!pill) return;
            activeFilter = pill.dataset.filter;
            $$('.filter-pill').forEach(p => p.classList.toggle('active', p === pill));
            renderHistory();
        });

        // History search
        historySearch.addEventListener('input', renderHistory);

        // Empty state → go to dashboard
        emptyAddBtn.addEventListener('click', () => navigate('dashboard'));

        // Data actions
        exportJsonBtn.addEventListener('click', exportJSON);
        exportCsvBtn.addEventListener('click', exportCSV);
        importFile.addEventListener('change', handleImport);
        clearBtn.addEventListener('click', handleClear);

        // Confirm dialog
        confirmNo.addEventListener('click', () => confirmOverlay.classList.add('hidden'));
    }

    // ═══════════════════════════════════════════════════════
    //  LIVE CALCULATION
    // ═══════════════════════════════════════════════════════
    function calculateLive() {
        const km    = parseFloat(kmInput.value);
        const price = parseFloat(priceInput.value);
        const spent = parseFloat(spentInput.value);
        
        const fuelRadio = $('input[name="fuelType"]:checked');
        const vehRadio = $('input[name="vehicleType"]:checked');
        const fuelType = fuelRadio ? fuelRadio.value : null;
        const vehicleType = vehRadio ? vehRadio.value : null;

        // UI Refs
        const prevBox = $('#preview-previous-cycle');
        const prevAmount = $('#prev-cycle-amount');
        const prevQty = $('#prev-cycle-qty');
        const prevDistance = $('#prev-cycle-distance');
        const prevMileage = $('#prev-cycle-mileage');
        const prevCost = $('#prev-cycle-cost');
        
        const newQty = $('#new-cycle-qty');
        const newTitle = $('#new-cycle-title');

        // Calculate current
        if (price > 0 && spent > 0) {
            const currentQty = (spent / price).toFixed(3);
            newQty.textContent = currentQty + (fuelType === 'CNG' ? ' kg' : ' L');
        } else {
            newQty.textContent = '--';
        }

        // Find previous pending entry
        let prevEntry = null;
        if (fuelType && vehicleType) {
            const group = entries.filter(e => e.vehicleType === vehicleType && e.fuelType === fuelType);
            group.sort((a, b) => {
                const dc = a.date.localeCompare(b.date);
                return dc !== 0 ? dc : a.createdAt - b.createdAt;
            });
            
            const formDate = dateInput.value;
            
            if (editingId) {
                const editIdx = group.findIndex(e => e.id === editingId);
                if (editIdx > 0) prevEntry = group[editIdx - 1];
            } else {
                const priorEntries = group.filter(e => e.date <= formDate);
                if (priorEntries.length > 0) {
                    prevEntry = priorEntries[priorEntries.length - 1];
                }
            }
        }

        if (prevEntry) {
            prevBox.classList.remove('hidden');
            prevBox.classList.add('flex');
            newTitle.textContent = 'New Fuel Cycle';

            prevAmount.textContent = '₹' + prevEntry.spent.toFixed(2);
            prevQty.textContent = prevEntry.qty + (fuelType === 'CNG' ? ' kg' : ' L');
            
            if (km > 0) {
                prevDistance.textContent = km + ' km';
                const mileage = (km / prevEntry.qty).toFixed(2);
                const cost = (prevEntry.spent / km).toFixed(2);
                prevMileage.textContent = mileage + (fuelType === 'CNG' ? ' km/kg' : ' km/L');
                prevCost.textContent = '₹' + cost + '/km';
            } else {
                prevDistance.textContent = '--';
                prevMileage.textContent = '--';
                prevCost.textContent = '--';
            }
        } else {
            prevBox.classList.add('hidden');
            prevBox.classList.remove('flex');
            newTitle.textContent = 'Starting Fuel Cycle';
        }
    }

    // ═══════════════════════════════════════════════════════
    //  FORM SUBMIT (Add / Edit)
    // ═══════════════════════════════════════════════════════
    async function handleSubmit(e) {
        e.preventDefault();

        const fuelType    = $('input[name="fuelType"]:checked').value;
        const vehicleType = $('input[name="vehicleType"]:checked').value;
        const km          = parseFloat(kmInput.value);
        const price       = parseFloat(priceInput.value);
        const spent       = parseFloat(spentInput.value);
        const date        = dateInput.value;

        if (isNaN(km) || isNaN(price) || isNaN(spent) || km < 0 || price <= 0 || spent <= 0) {
            showToast('Please fill all fields with valid numbers');
            return;
        }

        const qty  = +(spent / price).toFixed(3);
        const unit = fuelType === 'CNG' ? 'km/kg' : 'km/L';

        const entry = {
            id: editingId || generateId(),
            fuelType,
            vehicleType,
            km: km, // Keep for legacy
            tripEntered: km,
            price,
            spent,
            qty,
            unit,
            date,
            createdAt: editingId
                ? (entries.find(en => en.id === editingId)?.createdAt || Date.now())
                : Date.now(),
            updatedAt: Date.now(),
        };

        if (editingId) {
            const idx = entries.findIndex(en => en.id === editingId);
            if (idx !== -1) entries[idx] = entry;
        } else {
            entries.push(entry);
        }

        // Button animation
        const origHtml = submitBtn.innerHTML;
        submitBtn.innerHTML = `<span class="material-symbols-outlined text-[18px] animate-spin">sync</span><span>Saving...</span>`;
        submitBtn.classList.add('opacity-80', 'pointer-events-none');

        // recalculate and sync
        await recalculateAndSyncChains();

        setTimeout(() => {
            submitBtn.innerHTML = `<span class="material-symbols-outlined text-[18px]">check</span><span>Saved!</span>`;
            submitBtn.classList.replace('bg-primary', 'bg-secondary');

            setTimeout(() => {
                showToast(editingId ? 'Entry updated' : 'Entry saved. Reset Trip Meter to 0.');
                resetForm();
                submitBtn.innerHTML = origHtml;
                submitBtn.classList.replace('bg-secondary', 'bg-primary');
                submitBtn.classList.remove('opacity-80', 'pointer-events-none');
                render();
            }, 1500);
        }, 600);
    }

    async function persist(entry) {
        if (currentUser) {
            try { await putEntryFirestore(entry); } catch(e) { console.error(e); }
        }
        saveToLocalStorage();
    }

    // ─── Edit ───
    function startEdit(id) {
        const entry = entries.find(en => en.id === id);
        if (!entry) return;

        editingId = id;

        // Set radio buttons
        const fuelRadio = $(`input[name="fuelType"][value="${entry.fuelType}"]`);
        const vehRadio = $(`input[name="vehicleType"][value="${entry.vehicleType}"]`);
        if (fuelRadio) fuelRadio.checked = true;
        if (vehRadio) vehRadio.checked = true;

        kmInput.value    = entry.tripEntered !== undefined ? entry.tripEntered : entry.km;
        priceInput.value = entry.price;
        spentInput.value = entry.spent;
        dateInput.value  = entry.date;

        const isPetrol = entry.fuelType === 'Petrol';
        priceUnitLabel.textContent = isPetrol ? '₹/L' : '₹/kg';

        formHeadingText.textContent = 'Edit Entry';
        formIconEl.textContent = 'edit';
        submitBtnText.textContent = 'Update Entry';
        cancelEditBtn.classList.remove('hidden');

        calculateLive();
        navigate('dashboard');

        // Scroll form into view
        setTimeout(() => {
            fuelForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 400);
    }

    function cancelEdit() {
        resetForm();
    }

    function resetForm() {
        editingId = null;
        fuelForm.reset();
        setDefaultDate();

        // Reset radio defaults — CNG is the usual fill-up
        const cngRadio = $('input[name="fuelType"][value="CNG"]');
        const carRadio = $('input[name="vehicleType"][value="Car"]');
        if (cngRadio) cngRadio.checked = true;
        if (carRadio) carRadio.checked = true;

        priceInput.value = '83';
        priceUnitLabel.textContent = '₹/kg';

        formHeadingText.textContent = 'Log Fuel Entry';
        formIconEl.textContent = 'add_circle';
        submitBtnText.textContent = 'Save Entry';
        cancelEditBtn.classList.add('hidden');

        calculateLive();
    }

    // ─── Delete ───
    async function deleteEntry(id) {
        showConfirm('Delete this fuel entry?', async () => {
            entries = entries.filter(en => en.id !== id);
            if (currentUser) {
                try { await deleteEntryFirestore(id); } catch(e) { console.error(e); }
            }
            await recalculateAndSyncChains();
            showToast('🗑️ Entry deleted');
            render();
        });
    }

    // ═══════════════════════════════════════════════════════
    //  RENDER
    // ═══════════════════════════════════════════════════════
    function render() {
        updateStats();
        renderHistory();
        updateDataPage();
    }

    function updateStats() {
        const completedEntries = entries.filter(e => e.status === 'completed');
        
        const totalKm    = completedEntries.reduce((s, e) => s + (e.distanceDriven || 0), 0);
        const totalSpent = entries.reduce((s, e) => s + (e.spent || 0), 0);
        const totalQty   = completedEntries.reduce((s, e) => s + (e.qty || 0), 0);
        const overallAvg = totalQty > 0 ? (totalKm / totalQty).toFixed(1) : '—';

        // This month
        const now = new Date();
        const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const monthSpent = entries
            .filter(e => e.date && e.date.startsWith(monthStr))
            .reduce((s, e) => s + e.spent, 0);

        if (statTotalKm) statTotalKm.textContent      = formatNumber(totalKm);
        if (statTotalEntries) statTotalEntries.textContent = entries.length;
        if (statTotalSpent) statTotalSpent.textContent   = formatNumber(totalSpent);
        if (statOverallAvg) statOverallAvg.textContent   = overallAvg;
        if (statMonthSpent) statMonthSpent.textContent   = formatNumber(monthSpent);
        if (totalLogsCounter) totalLogsCounter.textContent = entries.length;

        // Progress bars (decorative, proportional) - Check if they exist first
        const maxKm = Math.max(totalKm, 1);
        if (barKm) barKm.style.width      = `${Math.min((totalKm / 50000) * 100, 100)}%`;
        if (barEntries) barEntries.style.width  = `${Math.min((entries.length / 100) * 100, 100)}%`;
        if (barAvg) barAvg.style.width      = overallAvg !== '—' ? `${Math.min((parseFloat(overallAvg) / 50) * 100, 100)}%` : '0%';
        if (barMonth) barMonth.style.width    = `${Math.min((monthSpent / 10000) * 100, 100)}%`;
    }

    function renderHistory() {
        const searchTerm = historySearch ? historySearch.value.toLowerCase().trim() : '';

        let filtered = [...entries];

        // Apply filter
        if (activeFilter !== 'All') {
            filtered = filtered.filter(e =>
                e.fuelType === activeFilter || e.vehicleType === activeFilter
            );
        }

        // Apply search
        if (searchTerm) {
            filtered = filtered.filter(e =>
                e.fuelType.toLowerCase().includes(searchTerm) ||
                e.vehicleType.toLowerCase().includes(searchTerm) ||
                e.date.includes(searchTerm) ||
                String(e.km).includes(searchTerm) ||
                String(e.spent).includes(searchTerm)
            );
        }

        // Sort latest first
        filtered.sort((a, b) => {
            const dc = b.date.localeCompare(a.date);
            return dc !== 0 ? dc : b.createdAt - a.createdAt;
        });

        // Show/hide states
        if (filtered.length === 0) {
            historyEmpty.classList.remove('hidden');
            historyEmpty.classList.add('flex');
            historyList.classList.add('hidden');
            historyList.classList.remove('grid');
        } else {
            historyEmpty.classList.add('hidden');
            historyEmpty.classList.remove('flex');
            historyList.classList.remove('hidden');
            historyList.classList.add('grid');
        }

        // Clear & rebuild
        historyList.innerHTML = '';

        filtered.forEach((entry, index) => {
            const clone = cardTemplate.content.cloneNode(true);
            const card = clone.querySelector('.ticket-card');

            // Stagger animation
            card.style.animationDelay = `${index * 50}ms`;
            card.classList.add('animate-fade-in-up');

            // Populate data
            clone.querySelector('.log-date').textContent = formatDatePretty(entry.date);
            clone.querySelector('.log-time').textContent = entry.date;
            clone.querySelector('.log-spent').textContent = formatNumber(entry.spent);
            clone.querySelector('.log-price').textContent = entry.price ? entry.price.toFixed(2) : '—';
            clone.querySelector('.log-price-unit').textContent = entry.fuelType === 'CNG' ? '/kg' : '/L';
            clone.querySelector('.log-fuel-badge').textContent = entry.fuelType;
            clone.querySelector('.log-vehicle-badge').textContent = `${entry.vehicleType === 'Car' ? '🚗' : '🏍️'} ${entry.vehicleType}`;

            const isPending = entry.status === 'pending';
            const kmEl = clone.querySelector('.log-km');
            const costEl = clone.querySelector('.log-cost-km');
            const mileageEl = clone.querySelector('.log-mileage');
            const statusBadge = clone.querySelector('.log-status-badge');
            const mileageBadge = clone.querySelector('.log-mileage-badge');

            if (isPending) {
                kmEl.textContent = 'Pending';
                kmEl.classList.add('text-sm', 'italic', 'text-on-surface-variant');
                kmEl.classList.remove('text-xl', 'text-on-surface');
                clone.querySelector('.log-km-unit')?.remove(); // if exists
                
                costEl.textContent = 'Pending';
                
                mileageEl.textContent = 'Pending';
                
                statusBadge.textContent = 'Active Cycle';
                statusBadge.classList.remove('completed', 'rotated-1');
                statusBadge.classList.add('pending', 'rotated-2');
                
                mileageBadge.classList.add('opacity-50');
            } else {
                kmEl.textContent = entry.distanceDriven;
                costEl.textContent = entry.costPerKm ? entry.costPerKm.toFixed(2) : '—';
                mileageEl.textContent = `${entry.mileage || '—'} ${entry.unit || 'km/L'}`;
                
                statusBadge.textContent = 'Completed';
                statusBadge.classList.remove('pending', 'rotated-2');
                statusBadge.classList.add('completed', 'rotated-1');
                
                mileageBadge.classList.remove('opacity-50');
            }

            // Edit handler
            clone.querySelector('.edit-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                startEdit(entry.id);
            });

            // Delete handler
            clone.querySelector('.delete-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                deleteEntry(entry.id);
            });

            historyList.appendChild(clone);
        });
    }

    function updateDataPage() {
        if (dataEntryCount) dataEntryCount.textContent = entries.length;
        if (dataStorageType) dataStorageType.textContent = currentUser ? 'Firebase' : 'localStorage';
    }

    // ═══════════════════════════════════════════════════════
    //  EXPORT / IMPORT
    // ═══════════════════════════════════════════════════════
    function exportJSON() {
        if (entries.length === 0) { showToast('No data to export'); return; }
        const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' });
        downloadBlob(blob, `fuel-tracker-${todayStr()}.json`);
        showToast('📥 Exported as JSON');
    }

    function exportCSV() {
        if (entries.length === 0) { showToast('No data to export'); return; }
        const headers = ['Date', 'Fuel Type', 'Vehicle Type', 'KM', 'Fuel Price', 'Amount Spent', 'Quantity', 'Mileage', 'Unit', 'Cost/km'];
        const rows = entries.map(e => [
            e.date, e.fuelType, e.vehicleType, e.km, e.price,
            e.spent, e.qty, e.mileage, e.unit, e.costPerKm
        ]);
        const csv = [headers, ...rows].map(r => r.map(c => `"${c}"`).join(',')).join('\n');
        const blob = new Blob([csv], { type: 'text/csv' });
        downloadBlob(blob, `fuel-tracker-${todayStr()}.csv`);
        showToast('📄 Exported as CSV');
    }

    async function handleImport(e) {
        const file = e.target.files[0];
        if (!file) return;

        try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (!Array.isArray(data)) throw new Error('Invalid format');

            const valid = data.filter(d =>
                d.fuelType && d.vehicleType && typeof d.km === 'number' && d.date
            );
            if (valid.length === 0) throw new Error('No valid entries found');

            for (const entry of valid) {
                if (!entry.id) entry.id = generateId();
                // Ensure all fields exist
                if (!entry.price && entry.spent && entry.qty) entry.price = +(entry.spent / entry.qty).toFixed(2);
                if (!entry.qty && entry.price && entry.spent) entry.qty = +(entry.spent / entry.price).toFixed(3);
                if (!entry.mileage && entry.km && entry.qty) entry.mileage = +(entry.km / entry.qty).toFixed(2);
                if (!entry.costPerKm && entry.km && entry.spent) entry.costPerKm = +(entry.spent / entry.km).toFixed(2);
                if (!entry.unit) entry.unit = entry.fuelType === 'CNG' ? 'km/kg' : 'km/L';
                if (!entry.createdAt) entry.createdAt = Date.now();
                entry.updatedAt = Date.now();

                const idx = entries.findIndex(en => en.id === entry.id);
                if (idx !== -1) entries[idx] = entry;
                else entries.push(entry);

                if (currentUser) { try { await putEntryFirestore(entry); } catch {} }
            }

            saveToLocalStorage();
            render();
            showToast(`📤 Imported ${valid.length} entries`);
        } catch (err) {
            showToast(`Import failed: ${err.message}`);
        }

        importFile.value = '';
    }

    function handleClear() {
        if (entries.length === 0) { showToast('Already empty'); return; }
        showConfirm('Delete ALL entries? This cannot be undone.', async () => {
            if (currentUser) {
                try { await clearFirestore(); } catch(e) { console.error(e); }
            }
            entries = [];
            saveToLocalStorage();
            render();
            resetForm();
            showToast('🗑️ All data cleared');
        });
    }

    // ═══════════════════════════════════════════════════════
    //  UTILITIES
    // ═══════════════════════════════════════════════════════
    function generateId() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    function formatDatePretty(dateStr) {
        try {
            const d = new Date(dateStr + 'T00:00:00');
            return d.toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric' });
        } catch { return dateStr; }
    }

    function formatNumber(n) {
        if (typeof n !== 'number' || isNaN(n)) return '0';
        return n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
    }

    function todayStr() {
        return new Date().toISOString().slice(0, 10);
    }

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
    }

    // ─── Toast ───
    let toastTimer;
    function showToast(msg) {
        toastEl.textContent = msg;
        toastEl.classList.add('toast-show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toastEl.classList.remove('toast-show'), 2800);
    }

    // ─── Confirm dialog ───
    function showConfirm(message, onConfirm) {
        confirmMessage.textContent = message;
        confirmOverlay.classList.remove('hidden');
        confirmYes.onclick = () => {
            confirmOverlay.classList.add('hidden');
            onConfirm();
        };
    }

    // ─── Public API for inline events ───
    window.FuelApp = { edit: startEdit, delete: deleteEntry };

    // ─── Go ───
    init();
