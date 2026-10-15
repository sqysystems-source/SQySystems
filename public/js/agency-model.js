// Pure schemas shared by the control plane and public login router.
import { normalizeMerchantEmail, validateTenantStore } from './tenant-config.js';
export const canManageAgency = profile => ['admin', 'superadmin'].includes(profile?.role);
export function normalizeEmail(value) {
    const email = normalizeMerchantEmail(value);
    if (!/^[^/@\s]+@[^/@\s]+\.[^/@\s]{2,}$/.test(email) || email.length > 254) throw new Error('Enter a valid email address.');
    return email;
}
const text = (value, name, max, required = true) => {
    const result = typeof value === 'string' ? value.trim() : '';
    if ((required && !result) || result.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result)) throw new Error(`${name} is required and must be at most ${max} characters.`);
    return result;
};
export const WEB_CONFIG_KEYS = Object.freeze(['apiKey','authDomain','projectId','storageBucket','messagingSenderId','appId']);
export function validateProvisioning(input) {
    const merchantEmail = normalizeEmail(input.merchantEmail);
    const storeName = text(input.storeName, 'Store name', 80);
    const storeApiBaseUrl = text(input.storeApiBaseUrl, 'Store API origin', 500);
    if (!['active','disabled'].includes(input.status)) throw new Error('Choose Active or Disabled.');
    let config;
    try { config = validateTenantStore({ storeName, storeApiBaseUrl, firebaseConfig: input.firebaseConfig }); }
    catch { throw new Error('Check the HTTPS API origin and all six public Firebase web config fields. No paths, service accounts or private keys are accepted.'); }
    return { merchantEmail, ...config, plan: text(input.plan || 'Custom E-Shop', 'Plan', 120), status: input.status };
}
export function descriptorFromRecord(email, data) {
    const deny = (code, message) => Object.assign(new Error(message), { code });
    if (['disabled','deleted'].includes(data?.status)) throw deny('portal/store-disabled', 'Η πρόσβαση στο κατάστημα δεν είναι διαθέσιμη. Επικοινωνήστε με τη SQySystems.');
    try {
        if (data?.status !== 'active' || normalizeEmail(data.merchantEmail) !== email) throw new Error('Invalid directory record.');
        return Object.freeze({ email, slug: email, source: 'master', plan: data.plan || 'Custom E-Shop', tenantStore: validateTenantStore({ storeName: data.storeName, storeApiBaseUrl: data.storeApiBaseUrl, firebaseConfig: data.firebaseConfig }) });
    } catch { throw deny('portal/store-not-configured', 'Το κατάστημά σας δεν είναι ακόμη διαθέσιμο. Επικοινωνήστε με τη SQySystems.'); }
}
export function connectionKey(descriptor) {
    const t = descriptor.tenantStore;
    return JSON.stringify([descriptor.email, t.storeName, t.storeApiBaseUrl, ...WEB_CONFIG_KEYS.map(key => t.firebaseConfig[key])]);
}
export function connectionVersion(record) {
    if (!record) return null;
    return JSON.stringify([record.merchantEmail, record.storeName, record.storeApiBaseUrl, record.plan, record.status, ...WEB_CONFIG_KEYS.map(key => record.firebaseConfig?.[key]), record.updatedAt ?? null]);
}
export function parsePaymentAmount(value) {
    const raw = String(value ?? '').trim().replace(',', '.');
    if (!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/.test(raw)) throw new Error('Enter an amount such as 700 or 700.50.');
    const [euros, cents = ''] = raw.split('.');
    const amount = Number(euros) * 100 + Number(cents.padEnd(2, '0'));
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 100000000) throw new Error('Amount must be between €0.01 and €1,000,000.');
    return amount;
}
export function validatePaidOrder(input) {
    const clientEmail = normalizeEmail(input.clientEmail);
    const clientName = text(input.clientName, 'Client name', 100);
    const packageDetails = text(input.packageDetails, 'Package details', 2000);
    const rawDate = String(input.paidDate || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) throw new Error('Choose a valid payment date.');
    const paidDate = new Date(`${rawDate}T12:00:00`);
    if (!Number.isFinite(paidDate.getTime()) || paidDate.getFullYear() !== Number(rawDate.slice(0,4)) || paidDate.getMonth()+1 !== Number(rawDate.slice(5,7)) || paidDate.getDate() !== Number(rawDate.slice(8,10))) throw new Error('Choose a valid payment date.');
    return { clientEmail, clientName, packageDetails, amountCents: parsePaymentAmount(input.amount), paidDate };
}
export const ticketStatus = message => ['read','resolved'].includes(message.status) ? message.status : 'unread';
export const isPaidOrder = payment => payment.status == null || payment.status === 'paid';
export function asMillis(value) {
    if (typeof value?.toMillis === 'function') return value.toMillis();
    if (typeof value?.seconds === 'number') return value.seconds * 1000 + (value.nanoseconds || 0) / 1e6;
    const millis = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : 0;
    return Number.isFinite(millis) ? millis : 0;
}
// A small literal-only parser for Firebase Console config snippets. No eval,
// Function(), executable expressions, template literals or arbitrary scripts.
export function parseFirebaseSnippet(raw) {
    if (typeof raw !== 'string' || raw.length > 12000) throw new Error('Paste a Firebase web config object (up to 12 KB).');
    let i = 0;
    const fail = () => { throw new Error('Use a JSON object or const firebaseConfig = { ... }; with quoted string values.'); };
    const skip = () => {
        while (i < raw.length) {
            if (/\s/.test(raw[i])) { i++; continue; }
            if (raw.slice(i,i+2) === '//') { const end = raw.indexOf('\n',i+2); i = end < 0 ? raw.length : end+1; continue; }
            if (raw.slice(i,i+2) === '/*') { const end = raw.indexOf('*/',i+2); if (end < 0) fail(); i = end+2; continue; }
            break;
        }
    };
    const string = () => {
        const quote = raw[i++];
        if (!['"',"'"].includes(quote)) fail();
        let result = '';
        while (i < raw.length) {
            let c = raw[i++];
            if (c === quote) return result;
            if (c === '\n' || c === '\r') fail();
            if (c === '\\') {
                c = raw[i++];
                const escapes = { n:'\n', r:'\r', t:'\t', b:'\b', f:'\f', '\\':'\\', "'":"'", '"':'"', '/':'/' };
                if (Object.hasOwn(escapes,c)) result += escapes[c];
                else if (c === 'u' && /^[0-9a-fA-F]{4}$/.test(raw.slice(i,i+4))) { result += String.fromCharCode(parseInt(raw.slice(i,i+4),16)); i += 4; }
                else fail();
            } else result += c;
        }
        fail();
    };
    skip();
    const declaration = raw.slice(i).match(/^(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*/);
    if (declaration) i += declaration[0].length;
    skip(); if (raw[i++] !== '{') fail();
    const values = Object.create(null);
    skip();
    while (raw[i] !== '}') {
        let key;
        if (['"',"'"].includes(raw[i])) key = string();
        else { const match = raw.slice(i).match(/^[A-Za-z_$][\w$]*/); if (!match) fail(); key = match[0]; i += key.length; }
        if (Object.hasOwn(values,key) || ![...WEB_CONFIG_KEYS,'measurementId','databaseURL'].includes(key)) throw new Error('Only public Firebase web config fields are allowed. Never paste a service account or private key.');
        skip(); if (raw[i++] !== ':') fail(); skip(); values[key] = string(); skip();
        if (raw[i] === ',') { i++; skip(); continue; }
        if (raw[i] !== '}') fail();
    }
    i++; skip(); if (raw[i] === ';') { i++; skip(); } if (i !== raw.length) fail();
    if (WEB_CONFIG_KEYS.some(key => !values[key])) throw new Error('The config must contain all six Firebase web fields.');
    return Object.fromEntries(WEB_CONFIG_KEYS.map(key => [key, values[key]]));
}
