// Shared by the landing-page modal and admin bridge. No Master Auth dependency.
import { initializeApp, deleteApp } from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-app.js';
import { getAuth, setPersistence, browserSessionPersistence, signInWithEmailAndPassword, signOut, sendPasswordResetEmail, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js';
import { getFirestore, doc, getDocFromServer, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js';
import { normalizeMerchantEmail, resolveMerchantStore, portalError, storeApiUrl } from './tenant-config.js';

export let app = null;
export let db = null;
export let auth = null;
export let tenantStore = null;
let descriptor = null;
let verifiedUser = null;
let operation = Promise.resolve();
const SESSION_KEY = 'sqysystems:managed-merchant:v1';
const LEGACY_KEY = 'sqysystems:tenant-session';
const serial = work => {
    const result = operation.then(work);
    operation = result.catch(() => {});
    return result;
};
export function clearMerchantHint() {
    verifiedUser = null;
    try { sessionStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(LEGACY_KEY); } catch { /* Firebase still owns the real session. */ }
}
function remember(user) {
    // This locator is NOT authorization. Restore always checks Firebase Auth,
    // the current code-owned directory, email, UID and a server-read admin role.
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ version: 1, email: descriptor.email, slug: descriptor.slug, uid: user.uid }));
    sessionStorage.removeItem(LEGACY_KEY);
}
async function prepare(next) {
    if (app && JSON.stringify(descriptor?.tenantStore) !== JSON.stringify(next.tenantStore)) {
        verifiedUser = null;
        await signOut(auth);
        await deleteApp(app);
        app = db = auth = null;
    }
    if (!app) {
        app = initializeApp(next.tenantStore.firebaseConfig, 'tenantStoreApp');
        db = getFirestore(app);
        auth = getAuth(app);
    }
    descriptor = next;
    tenantStore = next.tenantStore;
    await setPersistence(auth, browserSessionPersistence);
    await auth.authStateReady();
}
async function discardSession() {
    clearMerchantHint();
    if (auth) await signOut(auth);
}
async function verify(user) {
    if (!user || normalizeMerchantEmail(user.email) !== descriptor.email) throw portalError('portal/access-denied', 'Ο λογαριασμός δεν έχει πρόσβαση σε αυτό το κατάστημα.');
    const profile = await getDocFromServer(doc(db, 'users', user.uid));
    if (auth.currentUser?.uid !== user.uid || normalizeMerchantEmail(auth.currentUser?.email) !== descriptor.email) throw portalError('portal/session-changed', 'Η συνεδρία άλλαξε. Συνδεθείτε ξανά.');
    if (!profile.exists() || profile.data().role !== 'admin') throw portalError('portal/access-denied', 'Ο λογαριασμός δεν έχει πρόσβαση διαχειριστή. Επικοινωνήστε με τη SQySystems.');
    // If sessionStorage is unavailable, fail here rather than redirecting the
    // merchant to a second login screen after a seemingly successful login.
    remember(user);
    verifiedUser = user;
    return { currentUser: user, userData: profile.data(), tenantStore, storeSlug: descriptor.slug };
}
export function loginMerchant(email, password) {
    return serial(async () => {
        const next = resolveMerchantStore(email); // Never fall back to Master.
        if (typeof password !== 'string' || !password) throw portalError('portal/password-required', 'Συμπληρώστε τον κωδικό πρόσβασης.');
        clearMerchantHint();
        try {
            await prepare(next);
            // An old tenant login must not survive a rejected new attempt.
            if (auth.currentUser) await signOut(auth);
            const credential = await signInWithEmailAndPassword(auth, next.email, password);
            return await verify(credential.user);
        } catch (error) {
            try { await discardSession(); } catch { /* Still fail closed in UI. */ }
            throw error;
        }
    });
}
export function restoreMerchantSession() {
    return serial(async () => {
        let hint;
        try {
            sessionStorage.removeItem(LEGACY_KEY);
            hint = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
        } catch { clearMerchantHint(); return null; }
        if (!hint) return null;
        try {
            if (hint.version !== 1 || typeof hint.uid !== 'string' || !hint.uid) throw portalError('portal/expired', 'Συνδεθείτε ξανά.');
            const next = resolveMerchantStore(hint.email);
            if (hint.slug !== next.slug) throw portalError('portal/expired', 'Συνδεθείτε ξανά.');
            await prepare(next);
            const user = auth.currentUser;
            if (!user || user.uid !== hint.uid || normalizeMerchantEmail(user.email) !== next.email) {
                await discardSession();
                return null;
            }
            return await verify(user);
        } catch (error) {
            try { await discardSession(); } catch { /* Cleared locator is sufficient to prevent automatic reuse. */ }
            if (error.code === 'portal/expired' || error.code === 'portal/unknown-merchant') return null;
            throw error;
        }
    });
}
export function resetMerchantPassword(email) {
    return serial(async () => {
        await prepare(resolveMerchantStore(email));
        await sendPasswordResetEmail(auth, normalizeMerchantEmail(email));
    });
}
export function logoutMerchant() {
    clearMerchantHint(); // Lock API use immediately, before any queued operation.
    return serial(discardSession);
}
export function buildStoreApiUrl(path) {
    if (!verifiedUser || auth?.currentUser?.uid !== verifiedUser.uid) throw portalError('portal/no-session', 'Συνδεθείτε ξανά στο κατάστημά σας.');
    return storeApiUrl(tenantStore, path);
}
export function watchMerchantSession(onInvalidated) {
    if (!verifiedUser) throw new Error('No verified merchant session.');
    const user = verifiedUser;
    const expectedEmail = descriptor.email;
    let ended = false;
    const invalidate = () => {
        if (ended) return;
        ended = true;
        clearMerchantHint();
        onInvalidated();
    };
    const unsubscribeAuth = onAuthStateChanged(auth, current => {
        if (!current || current.uid !== user.uid || normalizeMerchantEmail(current.email) !== expectedEmail) invalidate();
    }, invalidate);
    const unsubscribeProfile = onSnapshot(doc(db, 'users', user.uid), { includeMetadataChanges: true }, snapshot => {
        if (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) return;
        if (!snapshot.exists() || snapshot.data().role !== 'admin') invalidate();
    }, invalidate);
    return () => { ended = true; unsubscribeAuth(); unsubscribeProfile(); };
}
export function merchantErrorMessage(error) {
    if (error?.code?.startsWith('portal/')) return error.message;
    if (['auth/invalid-credential', 'auth/user-not-found', 'auth/wrong-password', 'auth/invalid-email'].includes(error?.code)) return 'Το email ή ο κωδικός δεν είναι σωστά.';
    if (error?.code === 'auth/too-many-requests') return 'Πολλές προσπάθειες. Περιμένετε λίγο και δοκιμάστε ξανά.';
    if (['auth/network-request-failed', 'unavailable'].includes(error?.code)) return 'Δεν υπάρχει σύνδεση. Ελέγξτε το δίκτυό σας και δοκιμάστε ξανά.';
    if (['auth/web-storage-unsupported', 'auth/unsupported-persistence-type'].includes(error?.code) || error?.name === 'SecurityError' || error?.name === 'QuotaExceededError') return 'Επιτρέψτε την αποθήκευση συνεδρίας στον browser για να συνδεθείτε.';
    return 'Η σύνδεση δεν ολοκληρώθηκε. Δοκιμάστε ξανά ή επικοινωνήστε με τη SQySystems.';
}
