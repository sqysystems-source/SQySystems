// The root project is Master; all admin data and Bearer tokens are tenant-only.
import { auth as masterAuth, db as masterDb } from '../../firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, setPersistence, browserSessionPersistence } from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js';
import { getFirestore, doc, getDocFromServer, setDoc, onSnapshot, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js';
import { validateTenantStore, storeApiUrl } from './tenant-config.js';

// Live ES module bindings. No feature module may use them before onReady.
export let app = null;
export let db = null;
export let auth = null;
export let tenantStore = null;
export const buildStoreApiUrl = path => storeApiUrl(tenantStore, path);

const BINDING_KEY = 'sqysystems:tenant-session';
let started = false;
let active = false;
let verifiedUid = null;
let navigating = false;
let epoch = 0;
let stage = 'loading';
let tenantAuthUnsubscribe;
let tenantProfileUnsubscribe;
let masterProfileUnsubscribe;
let hooks;
const $ = id => document.getElementById(id);
const sameConfig = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function errorText(error) {
    if (error?.code === 'permission-denied') return 'Δεν επιτρέπεται η πρόσβαση. Ελέγξτε τους κανόνες Firestore και τον λογαριασμό σας.';
    if (error?.code?.startsWith('auth/')) return 'Η σύνδεση απέτυχε. Ελέγξτε email, κωδικό, ενεργοποίηση Email/Password και authorized domains στο σωστό Firebase project.';
    if (error?.code === 'unavailable') return 'Δεν υπάρχει σύνδεση με το Firebase. Ελέγξτε το δίκτυο και δοκιμάστε ξανά.';
    return error?.message || 'Η σύνδεση δεν ολοκληρώθηκε.';
}
function showError(error) {
    const target = stage === 'setup' ? $('tenant-setup-error') : $('login-error');
    target.textContent = errorText(error);
    target.classList.remove('hidden');
}
function showLogin(nextStage, message = '') {
    stage = nextStage;
    $('login-view').classList.remove('hidden');
    $('tenant-setup-view').classList.add('hidden');
    $('admin-login-form').hidden = !['master', 'tenant'].includes(stage);
    $('portal-retry').hidden = stage !== 'error';
    $('portal-login-title').textContent = stage === 'tenant' ? 'Σύνδεση καταστήματος' : 'SQySystems Merchant Portal';
    $('portal-login-description').textContent = message || (stage === 'master'
        ? 'Συνδεθείτε με τον λογαριασμό SQySystems.'
        : stage === 'tenant' ? `Συνδεθείτε με τα στοιχεία διαχειριστή του ${tenantStore.storeName}. Ο κωδικός δεν αποθηκεύεται από το portal.` : 'Έλεγχος ασφαλούς σύνδεσης…');
    $('login-error').classList.add('hidden');
    $('login-submit-btn').disabled = false;
    $('login-submit-btn').textContent = 'Σύνδεση';
    $('admin-password').value = '';
    if (stage === 'tenant' || stage === 'master') {
        $('admin-email').value = stage === 'tenant' ? (masterAuth.currentUser?.email || '') : '';
        $('admin-email').focus();
    }
    $('portal-master-logout').hidden = !masterAuth.currentUser;
    $('portal-login-configure').hidden = !masterAuth.currentUser;
}
function lock() {
    hooks?.onLocked();
    $('dashboard-view').classList.add('hidden');
    $('dashboard-view').classList.remove('flex');
}
function clearListeners() {
    tenantAuthUnsubscribe?.();
    tenantProfileUnsubscribe?.();
    masterProfileUnsubscribe?.();
    tenantAuthUnsubscribe = tenantProfileUnsubscribe = masterProfileUnsubscribe = null;
}
function readBinding() {
    try { return JSON.parse(sessionStorage.getItem(BINDING_KEY) || 'null'); } catch { return null; }
}
function clearBinding() {
    try { sessionStorage.removeItem(BINDING_KEY); } catch { /* Persistence may be disabled. */ }
}
function writeBinding(user) {
    try { sessionStorage.setItem(BINDING_KEY, JSON.stringify({ masterUid: masterAuth.currentUser.uid, projectId: tenantStore.firebaseConfig.projectId, tenantUid: user.uid })); } catch { /* Next visit will prompt again. */ }
}
async function reloadPortal(configure = false) {
    if (navigating) return;
    navigating = true;
    ++epoch;
    lock();
    clearListeners();
    clearBinding();
    showLogin('loading', 'Αλλαγή ασφαλούς συνεδρίας…');
    try { if (auth) await signOut(auth); }
    finally {
        const next = new URL(window.location.href);
        next.search = configure ? '?configure=1' : '';
        next.hash = '';
        window.location.replace(next.href);
    }
}
export async function logoutPortal() {
    if (navigating) return;
    navigating = true;
    ++epoch;
    lock();
    clearListeners();
    clearBinding();
    showLogin('loading', 'Αποσύνδεση…');
    // Both sessions must be cleared even if one signOut fails.
    const results = await Promise.allSettled([auth ? signOut(auth) : Promise.resolve(), signOut(masterAuth)]);
    if (results.some(result => result.status === 'rejected')) {
        navigating = false;
        showLogin('error', 'Η αποσύνδεση δεν ολοκληρώθηκε. Δοκιμάστε ξανά.');
        $('portal-master-logout').hidden = false;
        return;
    }
    window.location.replace(new URL('../../index.html', import.meta.url).href);
}
function showSetup() {
    stage = 'setup';
    $('login-view').classList.add('hidden');
    $('tenant-setup-view').classList.remove('hidden');
    $('tenant-setup-error').classList.add('hidden');
    $('tenant-store-name').value = tenantStore?.storeName || '';
    $('tenant-api-base').value = tenantStore?.storeApiBaseUrl || '';
    $('tenant-firebase-config').value = tenantStore ? JSON.stringify(tenantStore.firebaseConfig, null, 2) : '';
    $('tenant-cancel-setup').hidden = !tenantStore;
    $('tenant-store-name').focus();
}

async function connectTenant(config, masterUser, ticket) {
    tenantStore = config;
    app = initializeApp(config.firebaseConfig, 'tenantStoreApp');
    db = getFirestore(app);
    auth = getAuth(app);
    await setPersistence(auth, browserSessionPersistence);
    await auth.authStateReady();
    if (ticket !== epoch) return;
    const binding = readBinding();
    if (!binding || binding.masterUid !== masterUser.uid || binding.projectId !== config.firebaseConfig.projectId || binding.tenantUid !== auth.currentUser?.uid) {
        await signOut(auth);
        clearBinding();
    }
    if (ticket !== epoch) return;
    // Changes in another portal tab force a fresh app/module graph, never a
    // hot switch that could send an old store's writes to a new Firestore.
    masterProfileUnsubscribe = onSnapshot(doc(masterDb, 'users', masterUser.uid), { includeMetadataChanges: true }, snapshot => {
        if (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites || navigating || ticket !== epoch) return;
        let next;
        try { next = validateTenantStore(snapshot.data()?.tenantStore); } catch { void reloadPortal(); return; }
        if (!sameConfig(next, config)) void reloadPortal();
    }, error => {
        if (ticket !== epoch || navigating) return;
        if (active) { void reloadPortal(); return; }
        ++epoch;
        clearListeners();
        lock();
        showLogin('error');
        showError(error);
        void signOut(auth);
    });
    tenantAuthUnsubscribe = onAuthStateChanged(auth, async user => {
        if (ticket !== epoch || navigating) return;
        if (!user) {
            tenantProfileUnsubscribe?.();
            tenantProfileUnsubscribe = null;
            if (active) { void reloadPortal(); return; }
            showLogin('tenant');
            return;
        }
        if (active) {
            if (verifiedUid !== user.uid) void reloadPortal();
            return;
        }
        showLogin('loading', 'Επαλήθευση διαχειριστή στο Firebase του καταστήματος…');
        try {
            const profileRef = doc(db, 'users', user.uid);
            const profile = await getDocFromServer(profileRef);
            if (ticket !== epoch || navigating || auth.currentUser?.uid !== user.uid) return;
            if (!profile.exists() || profile.data().role !== 'admin') throw new Error('Ο λογαριασμός δεν έχει role: admin στο Firebase του καταστήματος.');
            writeBinding(user);
            stage = 'ready';
            active = true;
            verifiedUid = user.uid;
            document.querySelectorAll('[data-tenant-store-name]').forEach(el => { el.textContent = config.storeName; });
            $('portal-identity').textContent = `${user.email || user.uid} · ${config.firebaseConfig.projectId}`;
            document.title = `${config.storeName} — SQySystems Merchant Portal`;
            hooks.onReady({ currentUser: user, userData: profile.data() });
            tenantProfileUnsubscribe = onSnapshot(profileRef, { includeMetadataChanges: true }, snap => {
                if (ticket !== epoch || navigating || snap.metadata.fromCache || snap.metadata.hasPendingWrites) return;
                if (!snap.exists() || snap.data().role !== 'admin') void reloadPortal();
            }, () => { void reloadPortal(); });
        } catch (error) {
            if (ticket !== epoch || navigating) return;
            lock();
            if (active) { void reloadPortal(); return; }
            await signOut(auth);
            clearBinding();
            if (ticket !== epoch || navigating) return;
            showLogin('tenant');
            showError(error);
        }
    });
}

export function startTenantBridge(callbacks) {
    if (started) throw new Error('Tenant bridge already started.');
    started = true;
    hooks = callbacks;
    showLogin('loading');
    $('admin-login-form').addEventListener('submit', async event => {
        event.preventDefault();
        const loginStage = stage;
        if (!['master', 'tenant'].includes(loginStage)) return;
        const email = $('admin-email').value.trim();
        const password = $('admin-password').value;
        $('login-error').classList.add('hidden');
        $('login-submit-btn').disabled = true;
        $('login-submit-btn').textContent = 'Γίνεται σύνδεση…';
        try {
            await signInWithEmailAndPassword(loginStage === 'master' ? masterAuth : auth, email, password);
            $('admin-password').value = '';
        } catch (error) {
            if (!navigating) { showLogin(loginStage); $('admin-email').value = email; showError(error); }
        }
    });
    $('tenant-setup-form').addEventListener('submit', async event => {
        event.preventDefault();
        const user = masterAuth.currentUser;
        if (!user || navigating) return;
        const button = $('tenant-save-setup');
        button.disabled = true;
        $('tenant-setup-error').classList.add('hidden');
        try {
            let firebaseConfig;
            try { firebaseConfig = JSON.parse($('tenant-firebase-config').value); }
            catch { throw new Error('Το Firebase config πρέπει να είναι έγκυρο JSON με διπλά εισαγωγικά.'); }
            const config = validateTenantStore({ storeName: $('tenant-store-name').value, storeApiBaseUrl: $('tenant-api-base').value, firebaseConfig });
            await setDoc(doc(masterDb, 'users', user.uid), { uid: user.uid, tenantStore: config, updatedAt: serverTimestamp() }, { mergeFields: ['uid', 'tenantStore', 'updatedAt'] });
            await reloadPortal();
        } catch (error) { if (!navigating) showError(error); }
        finally { button.disabled = false; }
    });
    document.querySelectorAll('[data-configure-store]').forEach(button => button.addEventListener('click', () => { void reloadPortal(true); }));
    document.querySelectorAll('[data-portal-logout]').forEach(button => button.addEventListener('click', () => { void logoutPortal(); }));
    $('tenant-cancel-setup').addEventListener('click', () => { void reloadPortal(); });
    $('portal-retry').addEventListener('click', () => window.location.reload());
    onAuthStateChanged(masterAuth, async user => {
        if (navigating) return;
        const ticket = ++epoch;
        clearListeners();
        lock();
        if (active || app) { void reloadPortal(); return; }
        if (!user) { showLogin('master'); return; }
        showLogin('loading', 'Φόρτωση σύνδεσης καταστήματος…');
        try {
            const profile = await getDocFromServer(doc(masterDb, 'users', user.uid));
            if (ticket !== epoch || navigating) return;
            const rawConfig = profile.data()?.tenantStore;
            if (rawConfig) {
                try { tenantStore = validateTenantStore(rawConfig); }
                catch (error) { tenantStore = null; showSetup(); showError(error); return; }
            }
            if (!tenantStore || new URLSearchParams(window.location.search).get('configure') === '1') { showSetup(); return; }
            await connectTenant(tenantStore, user, ticket);
        } catch (error) {
            if (ticket !== epoch || navigating) return;
            showLogin('error');
            showError(error);
        }
    }, error => {
        if (navigating) return;
        ++epoch;
        clearListeners();
        lock();
        showLogin('error');
        showError(error);
        if (auth) void signOut(auth);
    });
}
