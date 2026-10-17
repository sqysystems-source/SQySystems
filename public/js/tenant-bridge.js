// Admin UI adapter. Both entry points use the same tenant session service.
import { loginMerchant, restoreMerchantSession, logoutMerchant, watchMerchantSession, merchantErrorMessage } from './merchant-session.js';
export { app, db, auth, tenantStore, buildStoreApiUrl } from './merchant-session.js';

const $ = id => document.getElementById(id);
let started = false;
let busy = false;
let active = false;
let navigating = false;
let stopWatching;
let hooks;
function lock() {
    hooks?.onLocked();
    $('dashboard-view').classList.add('hidden');
    $('dashboard-view').classList.remove('flex');
}
function loading(message) {
    $('login-view').classList.remove('hidden');
    $('admin-login-form').hidden = true;
    $('portal-login-description').textContent = message;
    $('portal-retry').hidden = true;
    $('login-error').classList.add('hidden');
}
function showLogin(error = null, fatal = false) {
    $('login-view').classList.remove('hidden');
    $('admin-login-form').hidden = fatal;
    $('portal-login-description').textContent = 'Συνδεθείτε για να διαχειριστείτε το κατάστημά σας.';
    $('login-submit-btn').disabled = false;
    $('login-submit-btn').textContent = 'Σύνδεση';
    $('admin-password').value = '';
    $('portal-retry').hidden = !fatal;
    $('login-error').textContent = error ? merchantErrorMessage(error) : '';
    $('login-error').classList.toggle('hidden', !error);
}
async function invalidate() {
    if (navigating) return;
    navigating = true;
    stopWatching?.();
    lock();
    loading('Η συνεδρία σας έληξε…');
    try { await logoutMerchant(); }
    finally {
        const destination = new URL(window.location.href);
        destination.search = '?notice=session-ended';
        destination.hash = '';
        window.location.replace(destination.href);
    }
}
function activate(session) {
    active = true;
    document.querySelectorAll('[data-tenant-store-name]').forEach(el => { el.textContent = session.tenantStore.storeName; });
    $('portal-identity').textContent = session.currentUser.email || '';
    document.title = `${session.tenantStore.storeName} — SQySystems Merchant Portal`;
    hooks.onReady(session);
    stopWatching = watchMerchantSession(() => { void invalidate(); });
}
export async function logoutPortal() {
    if (navigating) return;
    navigating = true;
    stopWatching?.();
    lock();
    loading('Αποσύνδεση…');
    try {
        await logoutMerchant();
        window.location.replace(new URL('../../index.html', import.meta.url).href);
    } catch (error) {
        navigating = false;
        showLogin(error, true);
    }
}
export function startTenantBridge(callbacks) {
    if (started) throw new Error('Tenant bridge already started.');
    started = true;
    hooks = callbacks;
    window.addEventListener('pagehide', () => {
        navigating = true;
        stopWatching?.();
        lock();
    });
    window.addEventListener('pageshow', event => {
        if (event.persisted) window.location.reload();
    });
    lock();
    $('portal-retry').addEventListener('click', () => window.location.reload());
    $('admin-login-form').addEventListener('submit', async event => {
        event.preventDefault();
        if (busy || navigating || active) return;
        busy = true;
        const email = $('admin-email').value;
        const password = $('admin-password').value;
        $('admin-password').value = '';
        loading('Γίνεται σύνδεση στο κατάστημά σας…');
        try {
            const session = await loginMerchant(email, password);
            if (!navigating) activate(session);
        }
        catch (error) {
            if (navigating) return;
            lock();
            if (active) { stopWatching?.(); await logoutMerchant().catch(() => {}); }
            showLogin(error, active);
        } finally { busy = false; }
    });
    busy = true;
    loading('Έλεγχος σύνδεσης…');
    void restoreMerchantSession().then(session => {
        if (navigating) return;
        if (session) activate(session);
        else showLogin();
    }).catch(async error => {
        if (navigating) return;
        lock();
        if (active) { stopWatching?.(); await logoutMerchant().catch(() => {}); }
        showLogin(error, active);
    }).finally(() => { busy = false; });
}
