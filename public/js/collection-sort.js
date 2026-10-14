// public/js/collection-sort.js
//
// COLLECTION SORTING — pure logic (no DOM, no Firestore), shared by
// collection.js and the Node tests.
//
// One sort key is active at a time, so the Price and Date controls can never
// disagree:
//
//   date_desc   newest first        <- default
//   date_asc    oldest first
//   price_asc   lowest price first
//   price_desc  highest price first
//
// "Date" is the product's ORIGINAL createdAt (never updatedAt, never the
// document id). "Price" is the EFFECTIVE listing price the card advertises
// (the sale price when discounted; for a variable product the lowest
// effective variation price), so the order always matches what the shopper
// sees on the cards.
//
// Ties are broken by document id ascending in every direction, so the order
// is total and identical on every page load, after every filter change and
// after every "Load more".
//
// Products without a usable createdAt (documents created before the field
// existed) are NEVER dropped: they count as the oldest products. Products
// without a usable price sort after every priced product in both price
// directions.

import { resolveListingPrice } from './pricing.js';

export const SORT_KEYS = Object.freeze(['date_desc', 'date_asc', 'price_asc', 'price_desc']);
export const DEFAULT_SORT = 'date_desc';

export function normalizeSortKey(value) {
    const key = String(value ?? '').trim().toLowerCase();
    return SORT_KEYS.includes(key) ? key : DEFAULT_SORT;
}

/** 'price' or 'date' — which control owns the active sort. */
export function getSortField(sortKey) {
    return normalizeSortKey(sortKey).startsWith('price') ? 'price' : 'date';
}

/**
 * Any serialized form of a Firestore timestamp -> milliseconds, or null.
 *
 * Handles: a Timestamp instance (toMillis / toDate), the plain objects
 * JSON.stringify() leaves in localStorage ({ seconds, nanoseconds } and the
 * Admin SDK's { _seconds, _nanoseconds }), a Date, an ISO/RFC date string and
 * a number (milliseconds).
 */
export function timestampToMillis(value) {
    if (value === null || value === undefined || value === '') return null;

    if (typeof value === 'number') {
        return Number.isFinite(value) && value > 0 ? value : null;
    }

    if (value instanceof Date) {
        const time = value.getTime();
        return Number.isFinite(time) && time > 0 ? time : null;
    }

    if (typeof value === 'string') {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }

    if (typeof value === 'object') {
        if (typeof value.toMillis === 'function') {
            try {
                return timestampToMillis(value.toMillis());
            } catch (_error) {
                return null;
            }
        }
        const seconds = Number(value.seconds ?? value._seconds);
        if (Number.isFinite(seconds)) {
            const nanos = Number(value.nanoseconds ?? value._nanoseconds ?? 0);
            const millis = seconds * 1000 + (Number.isFinite(nanos) ? Math.floor(nanos / 1e6) : 0);
            return millis > 0 ? millis : null;
        }
    }

    return null;
}

/** Original creation time in ms (createdAtMs written by the admin snapshot, else createdAt), or null. */
export function getCreatedAtMs(product) {
    if (!product || typeof product !== 'object') return null;
    return timestampToMillis(product.createdAtMs) ?? timestampToMillis(product.createdAt);
}

/** The effective listing price in cents, or null when the product has no usable price. */
export function getSortPriceCents(product) {
    const info = resolveListingPrice(product);
    return Number.isFinite(info.unitCents) && info.unitCents > 0 ? info.unitCents : null;
}

function compareIds(first, second) {
    const a = String(first?.id ?? '');
    const b = String(second?.id ?? '');
    if (a < b) return -1;
    return a > b ? 1 : 0;
}

/**
 * Returns a NEW array sorted by `sortKey`. Does not mutate the input.
 * The sort keys are computed once per product, not once per comparison.
 */
export function sortProducts(products, sortKey = DEFAULT_SORT) {
    const key = normalizeSortKey(sortKey);
    const decorated = (Array.isArray(products) ? products : []).map(product => ({
        product,
        created: getCreatedAtMs(product),
        price: getSortPriceCents(product)
    }));

    let compare;
    if (key === 'price_asc' || key === 'price_desc') {
        const direction = key === 'price_asc' ? 1 : -1;
        compare = (first, second) => {
            if (first.price === null && second.price === null) return compareIds(first.product, second.product);
            if (first.price === null) return 1;
            if (second.price === null) return -1;
            if (first.price !== second.price) return (first.price - second.price) * direction;
            return compareIds(first.product, second.product);
        };
    } else {
        const direction = key === 'date_asc' ? 1 : -1;
        // Unknown creation time = oldest.
        compare = (first, second) => {
            const a = first.created ?? 0;
            const b = second.created ?? 0;
            if (a !== b) return (a - b) * direction;
            return compareIds(first.product, second.product);
        };
    }

    return decorated.sort(compare).map(entry => entry.product);
}
