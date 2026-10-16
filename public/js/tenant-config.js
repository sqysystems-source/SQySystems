// Store connections are managed exclusively in Master merchant_stores.
// Empty legacy exports remain for compatibility with existing imports.
export const STORE_DIRECTORY = Object.freeze({});

export function portalError(code, message) {
    return Object.assign(new Error(message), { code });
}

const invalidConfig = () => portalError(
    'portal/store-not-configured',
    'Το κατάστημά σας δεν είναι ακόμη διαθέσιμο. Επικοινωνήστε με τη SQySystems.'
);

const CONFIG_KEYS = [
    'apiKey',
    'authDomain',
    'projectId',
    'storageBucket',
    'messagingSenderId',
    'appId',
];

const isObject = value =>
    value && typeof value === 'object' && !Array.isArray(value);

export function normalizeMerchantEmail(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

// No locally configured merchants.
export function hasManagedMerchant() {
    return false;
}

// Retained so existing imports do not break. No local connection is returned.
export function resolveMerchantStore() {
    throw portalError(
        'portal/unknown-merchant',
        'Δεν ήταν δυνατή η σύνδεση. Ελέγξτε τα στοιχεία σας ή επικοινωνήστε με τη SQySystems.'
    );
}

export function validateTenantStore(
    value,
    masterProjectId = 'sqysystems-faa0e'
) {
    if (
        !isObject(value) ||
        Object.keys(value).some(
            key => !['storeName', 'storeApiBaseUrl', 'firebaseConfig'].includes(key)
        )
    ) {
        throw invalidConfig();
    }

    const storeName =
        typeof value.storeName === 'string' ? value.storeName.trim() : '';

    if (
        !storeName ||
        storeName.length > 80 ||
        /[\u0000-\u001f\u007f]/.test(storeName)
    ) {
        throw invalidConfig();
    }

    const rawUrl =
        typeof value.storeApiBaseUrl === 'string'
            ? value.storeApiBaseUrl.trim()
            : '';

    let url;

    try {
        url = new URL(rawUrl);
    } catch {
        throw invalidConfig();
    }

    if (
        rawUrl.length > 500 ||
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/' ||
        !url.hostname.includes('.') ||
        url.port
    ) {
        throw invalidConfig();
    }

    const config = value.firebaseConfig;

    if (
        !isObject(config) ||
        Object.keys(config).length !== CONFIG_KEYS.length ||
        CONFIG_KEYS.some(
            key =>
                typeof config[key] !== 'string' ||
                !config[key].trim() ||
                config[key].length > 300 ||
                /^(PASTE_|YOUR_|REPLACE_)/i.test(config[key].trim())
        )
    ) {
        throw invalidConfig();
    }

    const firebaseConfig = Object.fromEntries(
        CONFIG_KEYS.map(key => [key, config[key].trim()])
    );

    if (
        !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(firebaseConfig.projectId) ||
        firebaseConfig.projectId === masterProjectId
    ) {
        throw invalidConfig();
    }

    if (!/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(firebaseConfig.authDomain)) {
        throw invalidConfig();
    }

    if (
        !/^\d+$/.test(firebaseConfig.messagingSenderId) ||
        !/^1:\d+:web:[A-Za-z0-9]+$/.test(firebaseConfig.appId)
    ) {
        throw invalidConfig();
    }

    return Object.freeze({
        storeName,
        storeApiBaseUrl: url.origin,
        firebaseConfig: Object.freeze(firebaseConfig),
    });
}

export function storeApiUrl(tenantStore, path) {
    if (!tenantStore) {
        throw portalError(
            'portal/no-session',
            'Συνδεθείτε ξανά στο κατάστημά σας.'
        );
    }

    if (
        typeof path !== 'string' ||
        !/^\/api\/(?:r2|send-email)(?:\?[^#\r\n]*)?$/.test(path) ||
        /[\\\u0000-\u0020]/.test(path)
    ) {
        throw new Error('Unsupported store API path.');
    }

    return tenantStore.storeApiBaseUrl + path;
}
