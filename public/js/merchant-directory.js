// Store routing uses only Master merchant_stores.
// No local directory, seed or fallback is used.
import { db as masterDb } from '../../firebase-config.js';
import {
    doc,
    getDocFromServer,
    onSnapshot,
} from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js';

import { portalError } from './tenant-config.js';
import { normalizeEmail, descriptorFromRecord } from './agency-model.js';

function resolveSnapshot(email, snapshot) {
    if (!snapshot.exists()) {
        return null;
    }

    // Disabled, deleted or invalid records are rejected by this validator.
    return descriptorFromRecord(email, snapshot.data());
}

export async function findMerchantStore(value) {
    let email;

    try {
        email = normalizeEmail(value);
    } catch {
        throw portalError(
            'portal/invalid-email',
            'Συμπληρώστε ένα έγκυρο email.'
        );
    }

    // Server confirmation is required. Network/permission errors propagate;
    // cached or locally configured connections are never substituted.
    const snapshot = await getDocFromServer(
        doc(masterDb, 'merchant_stores', email)
    );

    return resolveSnapshot(email, snapshot);
}

export function watchMerchantDirectory(value, onChange, onError) {
    let email;

    try {
        email = normalizeEmail(value);
    } catch {
        onError(
            portalError(
                'portal/invalid-email',
                'Συμπληρώστε ένα έγκυρο email.'
            )
        );

        return () => {};
    }

    return onSnapshot(
        doc(masterDb, 'merchant_stores', email),
        { includeMetadataChanges: true },
        snapshot => {
            if (
                snapshot.metadata.fromCache ||
                snapshot.metadata.hasPendingWrites
            ) {
                return;
            }

            try {
                onChange(resolveSnapshot(email, snapshot));
            } catch (error) {
                onError(error);
            }
        },
        onError
    );
}
