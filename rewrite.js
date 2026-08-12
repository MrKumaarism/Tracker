const fs = require('fs');
const path = require('path');

const appJsPath = path.join(__dirname, 'app.js');
let content = fs.readFileSync(appJsPath, 'utf8');

// 1. Remove IIFE
content = content.replace("(() => {\n    'use strict';", "");
content = content.replace(/\n\}\)\(\);\n?$/, "\n");

// 2. Add Imports
const imports = `import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { getFirestore, collection, doc, setDoc, deleteDoc, onSnapshot, enableIndexedDbPersistence, writeBatch } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCVP0l30IPY6YZ8QCd84bs8Eluhm4WS2hU",
  authDomain: "ritesh-portfolio-b76c9.firebaseapp.com",
  projectId: "ritesh-portfolio-b76c9",
  storageBucket: "ritesh-portfolio-b76c9.firebasestorage.app",
  messagingSenderId: "508723844443",
  appId: "1:508723844443:web:c9fb6fe3b58fa0b7bb367e",
  measurementId: "G-K5PY5Q1221"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const dbFirestore = getFirestore(app);

enableIndexedDbPersistence(dbFirestore).catch((err) => {
    console.warn("Firestore offline persistence error:", err);
});
`;

content = imports + "\n" + content;

// 3. Update State
content = content.replace("let useIndexedDB = true;", "let useIndexedDB = false;\n    let currentUser = null;\n    let unsubscribeSnapshot = null;");

// 4. Add DOM Refs for Login
const domRefsSearch = "const confirmNo      = $('#confirmNo');";
const domRefsReplace = `const confirmNo      = $('#confirmNo');

    // Auth
    const sidebarLoginBtn = $('#sidebarLoginBtn');
    const sidebarLoginText = $('#sidebarLoginText');
    const mobileLoginBtn = $('#mobileLoginBtn');
    const mobileLoginText = $('#mobileLoginText');`;
content = content.replace(domRefsSearch, domRefsReplace);

// 5. Update IndexedDB logic to Firestore
const idbStart = "// ═══════════════════════════════════════════════════════\n    //  IndexedDB\n    // ═══════════════════════════════════════════════════════";
const idbEnd = "// ─── localStorage fallback ───";
const idbRegex = new RegExp(idbStart.replace(/[.*+?^$\{}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + idbEnd.replace(/[.*+?^$\{}()|[\]\\]/g, '\\$&'));

const firestoreLogic = `// ═══════════════════════════════════════════════════════
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
            if (sidebarLoginText) sidebarLoginText.textContent = 'Login';
            if (mobileLoginText) mobileLoginText.textContent = 'Login';
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
        const entriesRef = collection(dbFirestore, 'users', currentUser.uid, 'entries');
        // Very simplistic clear (Note: in production, batch delete is better)
        entries.forEach(async (entry) => {
            await deleteEntryFirestore(entry.id);
        });
    }

    // ─── localStorage fallback ───`;

content = content.replace(idbRegex, firestoreLogic);

// 6. Update persist()
const persistRegex = /async function persist\(entry\) \{[\s\S]*?\}/;
const persistNew = `async function persist(entry) {
        if (currentUser) {
            try { await putEntryFirestore(entry); } catch(e) { console.error(e); }
        }
        saveToLocalStorage();
    }`;
content = content.replace(persistRegex, persistNew);

// 7. Update deleteEntry()
const deleteRegex = /async function deleteEntry\(id\) \{[\s\S]*?\}\);[\s\n]+?\}/;
const deleteNew = `async function deleteEntry(id) {
        showConfirm('Delete this fuel entry?', async () => {
            entries = entries.filter(en => en.id !== id);
            if (currentUser) {
                try { await deleteEntryFirestore(id); } catch(e) { console.error(e); }
            }
            saveToLocalStorage();
            showToast('🗑️ Entry deleted');
            render();
        });
    }`;
content = content.replace(deleteRegex, deleteNew);

// 8. Update init()
const initRegex = /async function init\(\) \{[\s\S]*?render\(\);\n    \}/;
const initNew = `async function init() {
        setDefaultDate();
        bindEvents();
        initNavigation();
        registerServiceWorker();

        // Initialize Firebase Auth which will load data
        initAuth();
    }`;
content = content.replace(initRegex, initNew);

// 9. Update bindEvents to add login clicks
const bindSearch = "cancelEditBtn.addEventListener('click', cancelEdit);";
const bindReplace = `cancelEditBtn.addEventListener('click', cancelEdit);

        if (sidebarLoginBtn) sidebarLoginBtn.addEventListener('click', handleLoginClick);
        if (mobileLoginBtn) mobileLoginBtn.addEventListener('click', handleLoginClick);`;
content = content.replace(bindSearch, bindReplace);

// 10. Update handleClear()
const clearRegex = /function handleClear\(\) \{[\s\S]*?\}\);[\s\n]+?\}/;
const clearNew = `function handleClear() {
        if (entries.length === 0) { showToast('Already empty'); return; }
        showConfirm('⚠️ Delete ALL entries? This cannot be undone.', async () => {
            if (currentUser) {
                try { await clearFirestore(); } catch(e) { console.error(e); }
            }
            entries = [];
            saveToLocalStorage();
            render();
            resetForm();
            showToast('🗑️ All data cleared');
        });
    }`;
content = content.replace(clearRegex, clearNew);

fs.writeFileSync(appJsPath, content, 'utf8');
console.log("Successfully rewrote app.js");
