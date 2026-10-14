// Pure configuration validation: only public Firebase web config belongs here.
const CONFIG_KEYS = ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId'];
const fail = message => { throw new Error(message); };
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);

export function validateTenantStore(value, masterProjectId = 'sqysystems-faa0e') {
    if (!isObject(value)) fail('Συμπληρώστε τα στοιχεία σύνδεσης καταστήματος.');
    if (Object.keys(value).some(key => !['storeName', 'storeApiBaseUrl', 'firebaseConfig'].includes(key))) {
        fail('Μη υποστηριζόμενο πεδίο σύνδεσης.');
    }
    const storeName = typeof value.storeName === 'string' ? value.storeName.trim() : '';
    if (!storeName || storeName.length > 80 || /[\u0000-\u001f\u007f]/.test(storeName)) fail('Το όνομα πρέπει να έχει 1–80 χαρακτήρες.');
    const rawUrl = typeof value.storeApiBaseUrl === 'string' ? value.storeApiBaseUrl.trim() : '';
    let url;
    try { url = new URL(rawUrl); } catch { fail('Δώστε έγκυρο HTTPS domain για το API.'); }
    if (rawUrl.length > 500 || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !url.hostname.includes('.') || url.port) {
        fail('Το API πρέπει να είναι HTTPS origin, π.χ. https://shop.vercel.app, χωρίς διαδρομή, θύρα ή κωδικούς.');
    }
    const config = value.firebaseConfig;
    if (!isObject(config) || Object.keys(config).length !== CONFIG_KEYS.length || CONFIG_KEYS.some(key => typeof config[key] !== 'string' || !config[key].trim() || config[key].length > 300)) {
        fail('Επικολλήστε μόνο τα έξι πεδία του δημόσιου Firebase web config (όχι service account).');
    }
    const firebaseConfig = Object.fromEntries(CONFIG_KEYS.map(key => [key, config[key].trim()]));
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(firebaseConfig.projectId)) fail('Μη έγκυρο Firebase projectId.');
    if (firebaseConfig.projectId === masterProjectId) fail('Το κατάστημα χρειάζεται ξεχωριστό Firebase project από το SQySystems.');
    if (!/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(firebaseConfig.authDomain)) fail('Το authDomain πρέπει να είναι hostname χωρίς https:// ή διαδρομή.');
    if (!/^\d+$/.test(firebaseConfig.messagingSenderId)) fail('Μη έγκυρο messagingSenderId.');
    if (!/^1:\d+:web:[A-Za-z0-9]+$/.test(firebaseConfig.appId)) fail('Μη έγκυρο Firebase web appId.');
    return { storeName, storeApiBaseUrl: url.origin, firebaseConfig };
}

export function storeApiUrl(tenantStore, path) {
    if (!tenantStore) fail('Δεν έχει συνδεθεί κατάστημα.');
    if (typeof path !== 'string' || !/^\/api\/(?:r2|send-email)(?:\?[^#\r\n]*)?$/.test(path) || /[\\\u0000-\u0020]/.test(path)) {
        fail('Μη επιτρεπτή διαδρομή API.');
    }
    return tenantStore.storeApiBaseUrl + path;
}
