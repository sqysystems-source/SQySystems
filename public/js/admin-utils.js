// public/js/admin-utils.js
//
// Shared primitives for the admin dashboard. This module imports NOTHING from
// the other admin modules, so it sits at the bottom of the dependency graph
// and can never participate in a cycle.
//
// `currentUser` is INJECTED by the orchestrator (admin.js) after
// onAuthStateChanged resolves, rather than imported, because it does not exist
// at module-evaluation time. Other modules read it via getCurrentUser().
//
// ---------------------------------------------------------------------------
// ON "SECURING THE SHARED FIREBASE INSTANCES"
// ---------------------------------------------------------------------------
// There is nothing to secure here, and nothing here could. `db` is the same
// tenant instance tenant-bridge.js creates; the Firebase web config is
// public by design and anyone can build an identical instance from the page
// source. Every guarantee about who may read or write what lives in
// firestore.rules. This module's job is narrower: never hand feature code a
// half-formed identity, and never lose an audit entry to a malformed payload.

import { db, auth } from './tenant-bridge.js';
import { collection, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js";

export { db, auth };

// ==========================================
// SHARED AUTH STATE (injected by admin.js)
// ==========================================
let currentUser = null;

/**
 * Called by the orchestrator when admin identity is verified, and on logout.
 *
 * Accepts only null or something shaped like a Firebase Auth User. Previously
 * any value was stored as-is, so a stray `setCurrentUser({})` or
 * `setCurrentUser(userDocSnap.data())` (a Firestore profile, not an Auth user)
 * left every module holding an "identity" whose getIdToken() did not exist —
 * which surfaced much later as a TypeError inside an upload or a delete.
 */
export function setCurrentUser(user) {
    if (user === null || user === undefined) {
        currentUser = null;
        return;
    }

    const looksLikeAuthUser = typeof user === 'object'
        && typeof user.uid === 'string'
        && user.uid.length > 0
        && typeof user.getIdToken === 'function';

    if (!looksLikeAuthUser) {
        console.error('[admin-utils] setCurrentUser rejected a value that is not a Firebase Auth user.');
        currentUser = null;
        return;
    }

    currentUser = user;
}

export function getCurrentUser() {
    return currentUser;
}

// ==========================================
// SHARED QUOTA CONSTANTS
// ==========================================
// Mirrors api/r2.js. The server's per-category limits are tighter (images
// 15 MB, documents 25 MB, audio 50 MB); this is only the absolute ceiling the
// browser checks before asking.
export const MAX_STORAGE_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB
export const MAX_SINGLE_FILE_BYTES = 200 * 1024 * 1024;  // 200 MB

// ==========================================
// 0. AUDIT LOGGING HELPER
// ==========================================

// Categories the Logs tab knows how to badge. Anything else is still written,
// under 'system', so a typo at a call site cannot silently drop an entry.
const KNOWN_LOG_CATEGORIES = new Set(['products', 'orders', 'cloud_drive', 'system']);

const LOG_LIMITS = {
    action: 40,
    category: 40,
    description: 1000,
    stringValue: 2000,
    metadataJsonChars: 20000,
    depth: 6,
    keysPerObject: 100,
    arrayItems: 200
};

function truncateString(value, maxLength) {
    const text = String(value);
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function safeStringify(value) {
    try {
        return JSON.stringify(value) ?? String(value);
    } catch (_error) {
        return '[unserialisable]';
    }
}

/**
 * Converts arbitrary caller metadata into something Firestore will accept.
 *
 * The previous logAdminAction() wrote `metadata` verbatim, and Firestore
 * rejects the WHOLE document for any one of:
 *   - an `undefined` anywhere in the tree ("Unsupported field value: undefined")
 *     — e.g. a product saved with no SKU, `{ sku: undefined }`
 *   - an array directly inside an array ("Nested arrays are not supported")
 *   - NaN / Infinity
 *   - a field name of the reserved form __name__
 *   - a document over 1 MiB
 * and addDoc()'s rejection went to a catch that only console.error'd. The
 * business action succeeded, the audit entry did not exist, and nothing on
 * screen said so. A schema change at any call site could silently switch
 * auditing off for that action.
 *
 * Every value is now coerced into a Firestore-legal shape rather than trusted.
 */
function toFirestoreSafe(value, depth = 0, insideArray = false) {
    if (value === null) return null;

    const type = typeof value;
    if (type === 'string') return truncateString(value, LOG_LIMITS.stringValue);
    if (type === 'number') return Number.isFinite(value) ? value : null;
    if (type === 'boolean') return value;
    if (type === 'bigint') return value.toString();
    if (type === 'undefined' || type === 'function' || type === 'symbol') return undefined;

    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value.toISOString();
    }

    if (depth >= LOG_LIMITS.depth) {
        return truncateString(safeStringify(value), LOG_LIMITS.stringValue);
    }

    if (Array.isArray(value)) {
        // Firestore forbids an array directly inside an array.
        if (insideArray) return truncateString(safeStringify(value), LOG_LIMITS.stringValue);

        return value.slice(0, LOG_LIMITS.arrayItems).map(item => {
            const safeItem = toFirestoreSafe(item, depth + 1, true);
            return safeItem === undefined ? null : safeItem;
        });
    }

    // Class instances — Errors, Files, DocumentReferences, FieldValues —
    // become their string form instead of an opaque rejection.
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        return truncateString(String(value), LOG_LIMITS.stringValue);
    }

    const safeObject = {};
    Object.keys(value).slice(0, LOG_LIMITS.keysPerObject).forEach(key => {
        const safeKey = String(key).slice(0, 100);
        // Empty names and the reserved __name__ form are rejected by Firestore.
        if (!safeKey || /^__.*__$/.test(safeKey)) return;

        const safeValue = toFirestoreSafe(value[key], depth + 1, false);
        if (safeValue !== undefined) safeObject[safeKey] = safeValue;
    });
    return safeObject;
}

function sanitizeLogMetadata(metadata) {
    const wrapped = metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
        ? metadata
        : { value: metadata };

    const safe = toFirestoreSafe(wrapped) || {};
    const serialised = safeStringify(safe);

    // A bulk operation that logs its whole payload (a 400-category list, a
    // full import) must not be able to push the entry past Firestore's
    // document limit.
    if (serialised.length > LOG_LIMITS.metadataJsonChars) {
        return {
            truncated: true,
            originalChars: serialised.length,
            preview: serialised.slice(0, LOG_LIMITS.metadataJsonChars)
        };
    }

    return safe;
}

function sanitizeLogText(value, maxLength, fallback) {
    // Control characters are stripped: the Logs tab renders these with
    // textContent/escapeHTML so they cannot execute, but they can still
    // forge line breaks in exports and copy-pasted incident reports.
    // eslint-disable-next-line no-control-regex
    const text = String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
    return text ? truncateString(text, maxLength) : fallback;
}

/**
 * Writes an activity log entry to Firestore.
 *
 * Deliberately FAIL-OPEN: an audit write that fails never blocks the business
 * action that triggered it (an order must still ship if the log is down). But
 * it is no longer silent — it now reports success, so a caller that cares can
 * react, and the console error names the action that went unrecorded.
 *
 * @param {string} action - e.g. 'CREATE', 'UPDATE', 'DELETE', 'EXPORT', 'IMPORT'
 * @param {string} category - 'products', 'orders', 'cloud_drive', 'system'
 * @param {string} description - Human readable description.
 * @param {object} metadata - Any additional JSON context.
 * @returns {Promise<boolean>} whether the entry was written
 */
export async function logAdminAction(action, category, description, metadata = {}) {
    // Snapshot the identity now. The write is async; a logout mid-flight must
    // not produce an entry attributed to nobody, or to the next admin.
    const actor = currentUser;
    if (!actor) return false;

    const safeAction = sanitizeLogText(action, LOG_LIMITS.action, 'UNKNOWN').toUpperCase();
    const requestedCategory = sanitizeLogText(category, LOG_LIMITS.category, 'system');
    const safeCategory = KNOWN_LOG_CATEGORIES.has(requestedCategory) ? requestedCategory : 'system';

    const entry = {
        adminEmail: actor.email || null,
        adminUid: actor.uid,
        action: safeAction,
        category: safeCategory,
        description: sanitizeLogText(description, LOG_LIMITS.description, ''),
        metadata: sanitizeLogMetadata(metadata),
        timestamp: serverTimestamp()
    };

    if (requestedCategory !== safeCategory) {
        entry.metadata = { ...entry.metadata, requestedCategory };
    }

    try {
        await addDoc(collection(db, 'admin_logs'), entry);
        return true;
    } catch (error) {
        console.error(`[Audit Log] Failed to write "${safeAction}" (${safeCategory}):`, error);
        return false;
    }
}

// ==========================================
// FORMATTING & CLOUD DRIVE ALERT HELPERS
// ==========================================

// Looked up at call time, not at module evaluation. The old module-scope
// getElementById() captured null forever if this file was ever evaluated
// before the markup existed (a <head> script tag, a test harness, a lazily
// injected section).
function getCloudDriveAlert() {
    return document.getElementById('cloud-drive-alert');
}

export function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    if (value >= 1024) return `${(value / 1024).toFixed(0)} KB`;
    return `${value} bytes`;
}

export function showCloudDriveAlert(message, type = 'error') {
    const cloudDriveAlert = getCloudDriveAlert();
    if (!cloudDriveAlert) return;

    const palettes = {
        error: 'bg-red-50 border-red-100 text-red-700',
        success: 'bg-emerald-50 border-emerald-100 text-emerald-700',
        info: 'bg-neutral-50 border-neutral-200 text-neutral-600'
    };

    cloudDriveAlert.className = `mb-8 px-5 py-4 rounded-sm border font-sans text-sm ${palettes[type] || palettes.error}`;
    cloudDriveAlert.textContent = message;
    cloudDriveAlert.classList.remove('hidden');
}

export function hideCloudDriveAlert() {
    const cloudDriveAlert = getCloudDriveAlert();
    if (cloudDriveAlert) cloudDriveAlert.classList.add('hidden');
}

// Exposed for tests only.
export const __test__ = { toFirestoreSafe, sanitizeLogMetadata };
