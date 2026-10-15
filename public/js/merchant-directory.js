// Public single-document lookups only; merchants never sign into Master Auth.
import { db as masterDb } from '../../firebase-config.js';
import { doc, getDocFromServer, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js';
import { resolveMerchantStore, portalError } from './tenant-config.js';
import { normalizeEmail, descriptorFromRecord } from './agency-model.js';
function seed(email) {
    try { return { ...resolveMerchantStore(email), source: 'seed' }; }
    catch (error) { if (error.code === 'portal/unknown-merchant') return null; throw error; }
}
function resolveSnapshot(email, snapshot) {
    // A disabled/deleted/invalid record is authoritative. Never fall back.
    return snapshot.exists() ? descriptorFromRecord(email, snapshot.data()) : seed(email);
}
export async function findMerchantStore(value) {
    let email;
    try { email = normalizeEmail(value); }
    catch { throw portalError('portal/invalid-email', 'Συμπληρώστε ένα έγκυρο email.'); }
    // No SDK cache or network-error fallback: only confirmed absence uses seed.
    return resolveSnapshot(email, await getDocFromServer(doc(masterDb, 'merchant_stores', email)));
}
export function watchMerchantDirectory(email, onChange, onError) {
    return onSnapshot(doc(masterDb, 'merchant_stores', email), { includeMetadataChanges: true }, snapshot => {
        if (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) return;
        try { onChange(resolveSnapshot(email, snapshot)); } catch (error) { onError(error); }
    }, onError);
}
