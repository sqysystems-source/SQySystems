// public/js/pricing.js
//
// BROWSER-SIDE PRICE RESOLUTION AND PRICE MARKUP.
//
// A product (or a variation) carries:
//   price      the regular price in EUR (legacy products have only this)
//   salePrice  OPTIONAL final discounted price in EUR. Honoured only when it
//              is a finite amount of whole cents, > 0 and STRICTLY below the
//              same document's regular price; otherwise ignored.
//
// Every storefront surface (cards, product page, cart, wishlist, search,
// checkout) calls resolveUnitPrice()/resolveListingPrice() and renders with
// buildPriceMarkup(), so the old price, the current price and the percentage
// badge are computed in exactly one place.
//
// MUST stay in step with server/lib/pricing.js, which decides what is
// actually CHARGED. The browser only ever DISPLAYS what this module computes;
// the server recomputes from Firestore and ignores whatever the browser sent.
//
// Money is handled in integer cents internally.

import { escapeHTML } from './sanitize.js';

const CENT_EPSILON = 1e-6;

// ------------------------------------------------------------------
// LANGUAGE (same source of truth as global.js: localStorage 'aura_lang',
// Greek by default)
// ------------------------------------------------------------------

export function getPricingLang() {
    try {
        return localStorage.getItem('aura_lang') === 'en' ? 'en' : 'el';
    } catch (_error) {
        return 'el';
    }
}

const PRICE_TEXT = {
    el: {
        from: 'Από',
        original: 'Αρχική τιμή',
        current: 'Τιμή με έκπτωση',
        off: 'έκπτωση'
    },
    en: {
        from: 'From',
        original: 'Original price',
        current: 'Discounted price',
        off: 'off'
    }
};

function priceText(key) {
    const lang = getPricingLang();
    return PRICE_TEXT[lang]?.[key] ?? PRICE_TEXT.en[key];
}

/**
 * Calls `callback(lang)` whenever the page language changes (global.js
 * changeLanguage() sets <html lang>). Returns a function that stops observing.
 */
export function observeLanguageChange(callback) {
    if (typeof MutationObserver !== 'function') return () => {};
    let lastLang = getPricingLang();
    const observer = new MutationObserver(() => {
        const lang = getPricingLang();
        if (lang === lastLang) return;
        lastLang = lang;
        callback(lang);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    return () => observer.disconnect();
}

// ------------------------------------------------------------------
// CENTS
// ------------------------------------------------------------------

/** Euros -> integer cents, or null when not a finite non-negative amount. */
export function toCents(value) {
    if (value === null || value === undefined || value === '') return null;
    const amount = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(amount) || amount < 0) return null;
    return Math.round(amount * 100);
}

/** Like toCents() but also requires a whole number of cents (no sub-cent part). */
export function toExactCents(value) {
    const cents = toCents(value);
    if (cents === null) return null;
    const amount = typeof value === 'number' ? value : Number(value);
    return Math.abs(amount * 100 - cents) <= CENT_EPSILON ? cents : null;
}

/** Whole percent taken off the regular price (1..99); 0 when there is no reduction. 123 -> 104 = 15. */
export function getDiscountPercent(regularCents, saleCents) {
    if (!Number.isFinite(regularCents) || !Number.isFinite(saleCents)) return 0;
    if (regularCents <= 0 || saleCents <= 0 || saleCents >= regularCents) return 0;
    const percent = Math.round((1 - saleCents / regularCents) * 100);
    return Math.min(99, Math.max(1, percent));
}

/**
 * Parses an EUR amount typed by an admin ("104", "104.5", "104,50").
 * Strict: finite, > 0, at most two decimals. Returns { ok, cents, value } or
 * { ok: false, reason } with reason one of 'empty' | 'format' | 'decimals' | 'zero'.
 */
export function parseEuroInput(raw) {
    const text = String(raw ?? '').trim().replace(/\s+/g, '').replace(',', '.');
    if (!text) return { ok: false, reason: 'empty' };
    if (!/^\d+(\.\d*)?$/.test(text)) return { ok: false, reason: 'format' };
    const [whole, fraction = ''] = text.split('.');
    if (fraction.length > 2) return { ok: false, reason: 'decimals' };
    const cents = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
    if (!Number.isSafeInteger(cents)) return { ok: false, reason: 'format' };
    if (cents <= 0) return { ok: false, reason: 'zero' };
    return { ok: true, cents, value: cents / 100 };
}

// ------------------------------------------------------------------
// RESOLUTION
// ------------------------------------------------------------------

/** The valid sale price of this product/variation in cents, or null. */
export function getSaleCents(item) {
    if (!item || typeof item !== 'object') return null;
    const regularCents = toCents(item.price);
    const saleCents = toExactCents(item.salePrice);
    if (regularCents === null || saleCents === null) return null;
    if (saleCents <= 0 || saleCents >= regularCents) return null;
    return saleCents;
}

function buildPriceInfo(regularCents, saleCents) {
    const onSale = saleCents !== null && regularCents !== null && saleCents < regularCents;
    const unitCents = onSale ? saleCents : regularCents;
    return {
        unitCents,
        regularCents,
        saleCents: onSale ? saleCents : null,
        onSale,
        discountPercent: onSale ? getDiscountPercent(regularCents, saleCents) : 0,
        unit: unitCents === null ? 0 : unitCents / 100,
        regular: regularCents === null ? 0 : regularCents / 100
    };
}

/**
 * What ONE unit of this purchasable product (a simple product or a single
 * variation) costs: { unitCents, regularCents, saleCents, onSale,
 * discountPercent, unit, regular } — unit/regular in EUR.
 */
export function resolveUnitPrice(item) {
    const regularCents = item && typeof item === 'object' ? toCents(item.price) : null;
    if (regularCents === null) return buildPriceInfo(null, null);
    return buildPriceInfo(regularCents, getSaleCents(item));
}

/**
 * The price a LISTING (card, search suggestion, social preview) advertises.
 *
 * Simple product: its own unit price.
 * Variable product: the lowest EFFECTIVE price among its IN-STOCK variations
 * (all variations when none is in stock) together with THAT SAME variation's
 * regular price — never one variation's original
 * price next to another one's discounted price. When several variations tie
 * on the lowest effective price, the one with the lowest regular price wins
 * (the more modest claim), then the lowest id, so the result is deterministic.
 * The parent is a listing, not a SKU: its own `price` is only a fallback.
 *
 * Without loaded variations a variable product falls back to the listing
 * price the admin panel stored (listingPrice / listingCompareAtPrice), then
 * to its regular `price`.
 *
 * Returns the resolveUnitPrice() shape plus { isFrom, variationId }.
 */
export function resolveListingPrice(product) {
    if (!product || typeof product !== 'object') {
        return { ...buildPriceInfo(null, null), isFrom: false, variationId: null };
    }

    if (product.type !== 'variable') {
        return { ...resolveUnitPrice(product), isFrom: false, variationId: null };
    }

    const allVariations = Array.isArray(product.variations) ? product.variations : [];
    // Variations that can be bought right now. A variation without a stock
    // figure (legacy data, or a caller that does not pass stock — e.g. the
    // admin panel computing the stored listing price) counts as available.
    // When every variation is sold out, the lowest price of all of them is
    // still shown (the card says "Out of Stock" beside it). This keeps the
    // advertised "From" price coherent with the stock the server patches
    // into the catalogue snapshot after each sale: selling out the cheapest
    // variation moves the price to the next one that can be bought.
    const available = allVariations.filter(variation => {
        if (!variation || variation.stock === undefined || variation.stock === null) return true;
        const stock = Number(variation.stock);
        return !Number.isFinite(stock) || stock > 0;
    });
    const hasPricedAvailable = available.some(variation => {
        const cents = resolveUnitPrice(variation).unitCents;
        return cents !== null && cents > 0;
    });
    const variations = hasPricedAvailable ? available : allVariations;
    let best = null;
    variations.forEach(variation => {
        const info = resolveUnitPrice(variation);
        if (info.unitCents === null || info.unitCents <= 0) return;
        const id = String(variation?.id ?? '');
        if (!best
            || info.unitCents < best.info.unitCents
            || (info.unitCents === best.info.unitCents && info.regularCents < best.info.regularCents)
            || (info.unitCents === best.info.unitCents
                && info.regularCents === best.info.regularCents
                && id < best.id)) {
            best = { info, id };
        }
    });
    if (best) return { ...best.info, isFrom: true, variationId: best.id || null };

    const listingCents = toExactCents(product.listingPrice);
    if (listingCents !== null && listingCents > 0) {
        const compareCents = toExactCents(product.listingCompareAtPrice);
        const info = compareCents !== null && compareCents > listingCents
            ? buildPriceInfo(compareCents, listingCents)
            : buildPriceInfo(listingCents, null);
        return { ...info, isFrom: true, variationId: null };
    }

    return { ...resolveUnitPrice(product), isFrom: true, variationId: null };
}

// ------------------------------------------------------------------
// FORMATTING AND MARKUP
// ------------------------------------------------------------------

/**
 * "€104", "€1,250.50" — whole amounts stay whole, anything with cents always
 * shows two digits. The same rule product.js and the cart drawer already used.
 */
export function formatEuro(value, { decimals = null } = {}) {
    const amount = Number(value);
    const safeAmount = Number.isFinite(amount) ? amount : 0;
    // `decimals: 2` (checkout, which always shows cents) forces two digits.
    const fractionDigits = decimals === 2 || Math.round(safeAmount * 100) % 100 !== 0 ? 2 : 0;
    return `€${safeAmount.toLocaleString(undefined, {
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: 2
    })}`;
}

const SIZE_CLASSES = {
    sm: { wrap: 'gap-x-1.5', old: 'text-[11px]', now: '', badge: 'text-[9px] px-1 py-px' },
    md: { wrap: 'gap-x-2', old: 'text-xs', now: '', badge: 'text-[10px] px-1.5 py-0.5' },
    lg: { wrap: 'gap-x-3', old: 'text-lg', now: '', badge: 'text-xs px-2 py-1' }
};

function sizeClasses(size) {
    return SIZE_CLASSES[size] || SIZE_CLASSES.md;
}

function renderPriceInner(info, { from = false, size = 'md', decimals = null } = {}) {
    const classes = sizeClasses(size);
    const money = (value) => escapeHTML(formatEuro(value, { decimals }));
    const prefix = from ? `<span class="aura-price-from">${escapeHTML(priceText('from'))}&nbsp;</span>` : '';

    if (!info.onSale) {
        return `${prefix}<span class="aura-price-current">${money(info.unit)}</span>`;
    }

    return `${prefix}`
        + `<span class="sr-only">${escapeHTML(priceText('original'))}: </span>`
        + `<del class="aura-price-old text-neutral-400 line-through ${classes.old}">${money(info.regular)}</del>`
        + `<span class="sr-only">${escapeHTML(priceText('current'))}: </span>`
        + `<span class="aura-price-current">${money(info.unit)}</span>`
        + `<span class="aura-price-badge inline-block bg-black text-white font-sans tracking-[0.1em] leading-none ${classes.badge}" aria-hidden="true">-${info.discountPercent}%</span>`
        + `<span class="sr-only"> ${info.discountPercent}% ${escapeHTML(priceText('off'))}</span>`;
}

/**
 * Price block for any surface. `info` is a resolveUnitPrice()/
 * resolveListingPrice() result. Carries its numbers in data attributes so
 * refreshPriceBlocks() can re-render it when the language switches.
 *
 * options: { from, size: 'sm'|'md'|'lg', align: 'start'|'center'|'end',
 *            decimals: 2 to always show cents, className, tag: 'span'|'p'|'div' }
 */
export function buildPriceMarkup(info, { from = false, size = 'md', align = 'center', decimals = null, className = '', tag = 'span' } = {}) {
    const safeInfo = info || buildPriceInfo(null, null);
    const wrapperTag = ['span', 'p', 'div'].includes(tag) ? tag : 'span';
    const classes = sizeClasses(size);
    const justify = align === 'start' ? 'justify-start' : (align === 'end' ? 'justify-end' : 'justify-center');
    const attrs = [
        'data-aura-price',
        `data-unit-cents="${Number.isFinite(safeInfo.unitCents) ? safeInfo.unitCents : ''}"`,
        `data-regular-cents="${Number.isFinite(safeInfo.regularCents) ? safeInfo.regularCents : ''}"`,
        `data-sale-cents="${Number.isFinite(safeInfo.saleCents) ? safeInfo.saleCents : ''}"`,
        `data-price-from="${from ? '1' : '0'}"`,
        `data-price-size="${escapeHTML(size)}"`,
        `data-price-decimals="${decimals === 2 ? '2' : ''}"`
    ].join(' ');

    return `<${wrapperTag} ${attrs} class="aura-price inline-flex flex-wrap items-baseline ${justify} ${classes.wrap} ${escapeHTML(className)}">`
        + renderPriceInner(safeInfo, { from, size, decimals })
        + `</${wrapperTag}>`;
}

function infoFromDataset(dataset) {
    const regularCents = dataset.regularCents === '' || dataset.regularCents === undefined ? null : Number(dataset.regularCents);
    const saleCents = dataset.saleCents === '' || dataset.saleCents === undefined ? null : Number(dataset.saleCents);
    return buildPriceInfo(
        Number.isFinite(regularCents) ? regularCents : null,
        Number.isFinite(saleCents) ? saleCents : null
    );
}

/** Re-renders every price block under `root` (call after a language switch). */
export function refreshPriceBlocks(root = document) {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    root.querySelectorAll('[data-aura-price]').forEach(element => {
        const info = infoFromDataset(element.dataset);
        element.innerHTML = renderPriceInner(info, {
            from: element.dataset.priceFrom === '1',
            size: element.dataset.priceSize || 'md',
            decimals: element.dataset.priceDecimals === '2' ? 2 : null
        });
    });
}
