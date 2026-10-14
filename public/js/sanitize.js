// public/js/sanitize.js
//
// Escaping helpers for building HTML from strings.
//
// ---------------------------------------------------------------------------
// THE PREVIOUS escapeHTML() WAS ALREADY CORRECT
// ---------------------------------------------------------------------------
// It escaped &, <, >, " and ' — all five — so the attribute interpolations
// across the admin panel (data-id, data-key, title=, value=) were sound. The
// Phase 1 note flagged it as *unverified*, not broken. It is now verified, and
// the chained .replace() calls are folded into one pass so the behaviour can
// never drift apart character by character.
//
// ---------------------------------------------------------------------------
// WHAT escapeHTML DOES NOT DO — read this before using it on a URL
// ---------------------------------------------------------------------------
// Escaping is about *containment*: it keeps a value inside the quoted slot it
// was written into. It says nothing about whether the value is safe once it
// gets there. In a URL-bearing attribute the two are not the same thing:
//
//     `<a href="${escapeHTML(link)}">`      with link = "javascript:alert(1)"
//
// produces exactly `<a href="javascript:alert(1)">`. Nothing needed escaping —
// there are no quotes or angle brackets in the payload — and the link executes
// on click. The same holds for `data:text/html,...` in an href or an iframe
// src. escapeHTML is the wrong tool; the scheme has to be checked.
//
// That is what safeUrl() below is for. Use it for every href, src, action,
// formaction, poster, and any CSS url().
//
// ---------------------------------------------------------------------------
// AND THE RULE ESCAPING CANNOT SAVE YOU FROM
// ---------------------------------------------------------------------------
// An escaped value is only safe in a slot where escaping is meaningful. These
// contexts are NOT made safe by escapeHTML, at all:
//
//   * Inside <script>:  `<script>var x = "${escapeHTML(v)}";</script>`
//     `</script>` inside a JS string still closes the block — the parser sees
//     the tag before the JS ever runs. Use escapeJSON(), or better, pass data
//     through a data attribute and read it with dataset.
//   * An UNQUOTED attribute: `<div class=${escapeHTML(v)}>` — a space is all an
//     attacker needs to add onclick=. Always quote.
//   * Inside a style attribute or <style> block. CSS has its own escaping.
//   * As a whole tag or attribute *name*.
//
// Rule of thumb: escape for text and quoted attributes, validate for URLs,
// and prefer textContent over innerHTML whenever the value is not markup.

/**
 * One lookup table, one pass. Ordering bugs (escaping & after < turns &lt;
 * into &amp;lt;) are impossible by construction, unlike a chain of replaces.
 *
 * The backtick is included because IE ≤ 11 treats it as an attribute
 * delimiter; it costs nothing and removes a footnote.
 */
const HTML_ESCAPES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
    '`': '&#96;'
};

const HTML_ESCAPE_PATTERN = /[&<>"'`]/g;

/**
 * Converts any value to a string and escapes every character that can change
 * the meaning of surrounding HTML.
 *
 * Safe for: text nodes and QUOTED attribute values.
 * Not safe for: URLs (use safeUrl), <script> bodies (use escapeJSON), CSS.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHTML(value) {
    if (value === null || value === undefined) return '';

    let asString;
    try {
        // String() throws on a Symbol and can throw on an object with a hostile
        // toString/valueOf. A render path must never be the thing that breaks.
        asString = typeof value === 'string' ? value : String(value);
    } catch (_error) {
        return '';
    }

    return asString.replace(HTML_ESCAPE_PATTERN, (character) => HTML_ESCAPES[character]);
}

/**
 * Explicit alias for attribute slots. Identical behaviour — it exists so the
 * intent is visible at the call site and nobody has to re-derive whether
 * escapeHTML covers quotes (it does).
 */
export const escapeAttribute = escapeHTML;

/**
 * Validates a URL for use in href/src and returns a safe value.
 *
 * Only http:, https:, mailto: and tel: pass. Everything else — javascript:,
 * data:, vbscript:, blob:, file:, unknown app schemes — collapses to the
 * fallback. Relative URLs are resolved against the current origin and
 * returned as-is when valid.
 *
 * Uses the URL parser rather than a regex on purpose: the parser strips
 * leading/trailing whitespace and control characters exactly the way the
 * browser's own navigation code does, which is where hand-rolled scheme
 * checks are normally defeated ("\tjava\nscript:alert(1)" and friends).
 *
 * The result still needs escapeHTML() when interpolated into an attribute.
 *
 * @param {unknown} value
 * @param {string} [fallback='#'] value returned when the URL is not allowed
 * @returns {string}
 */
export function safeUrl(value, fallback = '#') {
    if (value === null || value === undefined) return fallback;

    const candidate = String(value).trim();
    if (!candidate) return fallback;

    let parsed;
    try {
        parsed = new URL(candidate, window.location.origin);
    } catch (_error) {
        return fallback;
    }

    if (!['http:', 'https:', 'mailto:', 'tel:'].includes(parsed.protocol)) {
        return fallback;
    }

    return candidate;
}

/**
 * Like safeUrl but restricted to http/https — the right check for an image,
 * video or stylesheet source, where mailto: and tel: are meaningless.
 *
 * @param {unknown} value
 * @param {string} [fallback='']
 * @returns {string}
 */
export function safeMediaUrl(value, fallback = '') {
    if (value === null || value === undefined) return fallback;

    const candidate = String(value).trim();
    if (!candidate) return fallback;

    let parsed;
    try {
        parsed = new URL(candidate, window.location.origin);
    } catch (_error) {
        return fallback;
    }

    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? candidate : fallback;
}

/**
 * Serialises a value for embedding inside a <script> block.
 *
 * JSON.stringify alone is not enough: the HTML parser finds `</script>` inside
 * a JavaScript string literal and closes the block before the JS engine ever
 * sees it. `<!--` and the line separators U+2028/U+2029 cause related breakage.
 * All are escaped here into equivalent \u sequences that mean the same thing
 * to JSON and nothing to the HTML parser.
 *
 * Prefer a data attribute plus dataset over inline script data where you can.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeJSON(value) {
    let serialised;
    try {
        serialised = JSON.stringify(value);
    } catch (_error) {
        return 'null';
    }

    if (typeof serialised !== 'string') return 'null';

    return serialised
        .replace(/</g, '\\u003C')
        .replace(/>/g, '\\u003E')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

/**
 * Writes text into an element without going through innerHTML at all.
 *
 * The escaping-free option, and the one to reach for by default: there is no
 * parser involved, so there is no context to get wrong. Silently no-ops on a
 * missing element so a render path never throws on a DOM that changed.
 *
 * @param {Element|null|undefined} element
 * @param {unknown} value
 */
export function setText(element, value) {
    if (!element) return;
    element.textContent = value === null || value === undefined ? '' : String(value);
}
