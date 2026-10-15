// AGENCY-OWNED DIRECTORY. Edit this file and deploy the agency portal.
// Only public Firebase WEB config belongs here; never service-account/R2/Resend secrets.

// ===== AURA: paste the SIX web config values here ONCE =====
export const AURA_FIREBASE_CONFIG = Object.freeze({
  "apiKey": "AIzaSyAA1jFUzkoroxr6Dg4opV_pxqbBKW2xnnY",
  "authDomain": "test-db-f6315.firebaseapp.com",
  "projectId": "test-db-f6315",
  "storageBucket": "test-db-f6315.firebasestorage.app",
  "messagingSenderId": "166750781296",
  "appId": "1:166750781296:web:47a26779b4ba9441ca59b5"
});
// =========================================================

export const STORE_DIRECTORY = Object.freeze({
    aura: Object.freeze({
        merchantEmails: Object.freeze(['kostas6603@gmail.com']),
        storeName: 'AURA',
        storeApiBaseUrl: 'https://www.sqysystemsdev.org',
        firebaseConfig: AURA_FIREBASE_CONFIG,
    }),
    // Add stores using the same shape and a unique slug. Each merchant email
    // must appear in exactly one entry. Every tenant still requires role: admin.
});

export function portalError(code, message) {
    return Object.assign(new Error(message), { code });
}
const invalidConfig = () => portalError('portal/store-not-configured', 'Το κατάστημά σας δεν είναι ακόμη διαθέσιμο. Επικοινωνήστε με τη SQySystems.');
const CONFIG_KEYS = ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId'];
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
export function normalizeMerchantEmail(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}
function matchingStores(email) {
    const key = normalizeMerchantEmail(email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(key) || key.length > 254) return [];
    return Object.entries(STORE_DIRECTORY).filter(([, store]) =>
        store.merchantEmails.some(merchant => normalizeMerchantEmail(merchant) === key));
}
export function hasManagedMerchant(email) {
    return matchingStores(email).length > 0;
}
export function validateTenantStore(value, masterProjectId = 'sqysystems-faa0e') {
    if (!isObject(value) || Object.keys(value).some(key => !['storeName', 'storeApiBaseUrl', 'firebaseConfig'].includes(key))) throw invalidConfig();
    const storeName = typeof value.storeName === 'string' ? value.storeName.trim() : '';
    if (!storeName || storeName.length > 80 || /[\u0000-\u001f\u007f]/.test(storeName)) throw invalidConfig();
    const rawUrl = typeof value.storeApiBaseUrl === 'string' ? value.storeApiBaseUrl.trim() : '';
    let url;
    try { url = new URL(rawUrl); } catch { throw invalidConfig(); }
    if (rawUrl.length > 500 || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !url.hostname.includes('.') || url.port) throw invalidConfig();
    const config = value.firebaseConfig;
    if (!isObject(config) || Object.keys(config).length !== CONFIG_KEYS.length || CONFIG_KEYS.some(key => typeof config[key] !== 'string' || !config[key].trim() || config[key].length > 300 || /^(PASTE_|YOUR_|REPLACE_)/i.test(config[key].trim()))) throw invalidConfig();
    const firebaseConfig = Object.fromEntries(CONFIG_KEYS.map(key => [key, config[key].trim()]));
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(firebaseConfig.projectId) || firebaseConfig.projectId === masterProjectId) throw invalidConfig();
    if (!/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(firebaseConfig.authDomain)) throw invalidConfig();
    if (!/^\d+$/.test(firebaseConfig.messagingSenderId) || !/^1:\d+:web:[A-Za-z0-9]+$/.test(firebaseConfig.appId)) throw invalidConfig();
    return Object.freeze({ storeName, storeApiBaseUrl: url.origin, firebaseConfig: Object.freeze(firebaseConfig) });
}
export function resolveMerchantStore(email) {
    const matches = matchingStores(email);
    if (matches.length === 0) throw portalError('portal/unknown-merchant', 'Δεν ήταν δυνατή η σύνδεση. Ελέγξτε τα στοιχεία σας ή επικοινωνήστε με τη SQySystems.');
    if (matches.length !== 1) throw invalidConfig();
    const [slug, entry] = matches[0];
    return Object.freeze({ slug, email: normalizeMerchantEmail(email), tenantStore: validateTenantStore({ storeName: entry.storeName, storeApiBaseUrl: entry.storeApiBaseUrl, firebaseConfig: entry.firebaseConfig }) });
}
export function storeApiUrl(tenantStore, path) {
    if (!tenantStore) throw portalError('portal/no-session', 'Συνδεθείτε ξανά στο κατάστημά σας.');
    if (typeof path !== 'string' || !/^\/api\/(?:r2|send-email)(?:\?[^#\r\n]*)?$/.test(path) || /[\\\u0000-\u0020]/.test(path)) throw new Error('Unsupported store API path.');
    return tenantStore.storeApiBaseUrl + path;
}
