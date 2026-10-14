import { db } from './firebase-config.js';
import { doc, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js';
import { categoryTree } from './category-model.js';
import { removeCache } from './cache.js';

// One shared settings document listener per page (navbar/sidebar/admin).
// Never use the legacy two-hour cache, even on the first page visit.
let tree = null;
let ready = null;
const subscribers = new Set();
export function getCategoryTree() {
    if (!ready) {
        removeCache('settings_categories');
        ready = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Category settings connection timed out')), 10000);
            onSnapshot(doc(db, 'settings', 'categories'), { includeMetadataChanges: true }, snap => {
                // Wait for server confirmation: SDK cache is not authoritative.
                if (snap.metadata.fromCache || snap.metadata.hasPendingWrites) return;
                clearTimeout(timeout);
                const next = categoryTree(snap.exists() ? snap.data().list : []);
                const changed = JSON.stringify(next) !== JSON.stringify(tree);
                tree = next;
                resolve(tree);
                if (changed) subscribers.forEach(fn => fn(tree));
            }, error => { clearTimeout(timeout); reject(error); console.error('Category tree unavailable', error); });
        });
    }
    if (tree !== null) return Promise.resolve(tree);
    return ready.then(() => tree);
}
export function subscribeCategoryTree(callback) {
    subscribers.add(callback);
    getCategoryTree().catch(() => {});
    return () => subscribers.delete(callback);
}
