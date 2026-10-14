// Shared read-side snapshot listener. Schema v3 adds optional brand/subcategoryId.
// The supplied baseline was v2 with a two-hour TTL; it contained no revision /
// dirty-marker protocol. Keep the existing writer/stock transaction contract.
import { db } from './firebase-config.js';
import { doc, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js';
import { removeCache } from './cache.js';

export const CATALOG_SNAPSHOT_VERSION = 3;
let snapshotPromise = null;
let products = null;
let signature;
export function getCatalogSnapshot() {
    if (!snapshotPromise) {
        snapshotPromise = new Promise(resolve => {
            // A disconnected SDK may only emit fromCache. Do not hang the page.
            const timeout = setTimeout(() => resolve(null), 10000);
            onSnapshot(doc(db, 'settings', 'catalog'), { includeMetadataChanges: true }, snap => {
                if (snap.metadata.fromCache || snap.metadata.hasPendingWrites) return;
                clearTimeout(timeout);
                const data = snap.exists() ? snap.data() : null;
                const next = data?.v === CATALOG_SNAPSHOT_VERSION && !data.dirty && Array.isArray(data.products)
                    ? data.products : null;
                const nextSignature = JSON.stringify(data);
                const changed = signature !== undefined && signature !== nextSignature;
                signature = nextSignature;
                products = next;
                resolve(products);
                if (changed) {
                    ['collection_catalog_live_v4', 'search_catalog_v3'].forEach(key => removeCache(key));
                    window.dispatchEvent(new CustomEvent('catalog:updated'));
                }
            }, error => {
                clearTimeout(timeout);
                console.warn('Catalog snapshot unavailable; using live queries.', error);
                resolve(null);
            });
        });
    }
    return snapshotPromise.then(() => products);
}
export function isListableProduct(product) {
    return Boolean(product) && (product.type === 'simple' || product.type === 'variable');
}
