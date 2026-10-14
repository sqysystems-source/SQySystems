// public/js/admin-products.js
//
// Products lifecycle: fetch/render, add + edit modal forms, dynamic image
// rows with R2-backed removal, presigned product-media upload, PapaParse CSV
// bulk import with chunked batch writes, and CSV export.
//
// CROSS-MODULE DEPENDENCY (one-directional, verified acyclic):
// product image upload/delete changes the tenant's storage usage, which is
// owned by admin-cloud-and-logs.js. This module imports adjustStorageUsage()
// and updateStorageUIOnly() from there. admin-cloud-and-logs.js imports
// NOTHING from this module, so no cycle exists.

import { db, logAdminAction, getCurrentUser } from './admin-utils.js';
import { adjustStorageUsage, updateStorageUIOnly } from './admin-cloud-and-logs.js';
import { collection, getDocs, doc, getDoc, setDoc, updateDoc, deleteDoc, serverTimestamp, deleteField, writeBatch, query, where, runTransaction } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js";
import { escapeHTML } from './sanitize.js';
import { categoryTree, optionalProductFields, importOptionalFields, findSubcategory, encodeCsvCell, decodeCsvText, importVariationFields } from './category-model.js';
import { getCategoryTree, subscribeCategoryTree } from './category-store.js';
import { CATALOG_SNAPSHOT_VERSION } from './catalog-snapshot.js';
import { getDiscountPercent, getSaleCents, parseEuroInput, resolveListingPrice, toCents } from './pricing.js';
import { timestampToMillis } from './collection-sort.js';

/**
 * Wires the Products tab (incl. bulk import + edit modal) and loads products.
 * @param {{ currentUser: import('firebase/auth').User }} context
 */
export function initProductsModule(context) {
    const productsTableBody = document.getElementById('products-table-body');
    const toggleAddProductBtn = document.getElementById('toggle-add-product-btn');
    const addProductContainer = document.getElementById('add-product-container');
    const addProductForm = document.getElementById('add-product-form');
    const cancelAddBtn = document.getElementById('cancel-add-btn');
    const exportProductsCsvBtn = document.getElementById('export-products-csv-btn');

    // Bulk Import Elements
    const openBulkImportBtn = document.getElementById('open-bulk-import-btn');
    const bulkImportModal = document.getElementById('bulk-import-modal');
    const bulkImportBackdrop = document.getElementById('bulk-import-backdrop');
    const closeBulkImportBtn = document.getElementById('close-bulk-import-btn');
    const downloadCsvTemplateBtn = document.getElementById('download-csv-template-btn');
    const csvDropzone = document.getElementById('csv-dropzone');
    const csvFileInput = document.getElementById('csv-file-input');
    const csvPreviewContainer = document.getElementById('csv-preview-container');
    const csvErrors = document.getElementById('csv-errors');
    const csvRowsCount = document.getElementById('csv-rows-count');
    const csvPreviewTbody = document.getElementById('csv-preview-tbody');
    const startBulkImportBtn = document.getElementById('start-bulk-import-btn');
    const csvProgressContainer = document.getElementById('csv-progress-container');
    const csvProgressText = document.getElementById('csv-progress-text');
    const csvProgressPercent = document.getElementById('csv-progress-percent');
    const csvProgressBar = document.getElementById('csv-progress-bar');
    let parsedCsvData = [];

    // Edit Modal Elements
    const editModal = document.getElementById('edit-modal');
    const editModalBackdrop = document.getElementById('edit-modal-backdrop');
    const closeModalBtn = document.getElementById('close-modal-btn');
    const editProductForm = document.getElementById('edit-product-form');
    
    // Dynamic Images Elements
    const addImageBtn = document.getElementById('add-image-btn');
    const addImageInputsContainer = document.getElementById('add-image-inputs');
    const editAddImageBtn = document.getElementById('edit-add-image-btn');
    const editImageInputsContainer = document.getElementById('edit-image-inputs');

    // Floating image preview shared by the Add and Edit image URL fields.
    // It is appended to <body> so it is not clipped by scrollable modal/form
    // containers and cannot affect their layout.
    const imagePreviewTooltip = document.createElement('div');
    imagePreviewTooltip.id = 'admin-image-preview-tooltip';
    imagePreviewTooltip.className = 'hidden pointer-events-none absolute z-[1000] w-48 h-48 overflow-hidden rounded-sm border border-gray-200 bg-white p-2 shadow-xl';
    imagePreviewTooltip.setAttribute('aria-hidden', 'true');

    const imagePreviewElement = document.createElement('img');
    imagePreviewElement.className = 'h-full w-full object-contain';
    imagePreviewElement.alt = '';
    imagePreviewElement.decoding = 'async';
    imagePreviewTooltip.appendChild(imagePreviewElement);
    document.body.appendChild(imagePreviewTooltip);

    const isPreviewableImageUrl = (value) => /^(https?:\/\/|data:)/i.test(value);

    function hideImagePreview() {
        imagePreviewTooltip.classList.add('hidden');
        imagePreviewTooltip.setAttribute('aria-hidden', 'true');
        imagePreviewElement.removeAttribute('src');
    }

    function positionImagePreview(event) {
        imagePreviewTooltip.style.left = `${event.pageX + 16}px`;
        imagePreviewTooltip.style.top = `${event.pageY + 16}px`;
    }

    function showImagePreview(input, event) {
        const imageUrl = input.value.trim();
        if (!isPreviewableImageUrl(imageUrl)) {
            hideImagePreview();
            return;
        }

        imagePreviewElement.src = imageUrl;
        imagePreviewTooltip.classList.remove('hidden');
        imagePreviewTooltip.setAttribute('aria-hidden', 'false');
        positionImagePreview(event);
    }

    function attachImagePreviewDelegation(container, inputSelector) {
        if (!container) return;

        container.addEventListener('mouseover', (event) => {
            const input = event.target.closest(inputSelector);
            if (!input || !container.contains(input)) return;
            showImagePreview(input, event);
        });

        container.addEventListener('mousemove', (event) => {
            const input = event.target.closest(inputSelector);
            if (!input || !container.contains(input) || imagePreviewTooltip.classList.contains('hidden')) return;
            positionImagePreview(event);
        });

        container.addEventListener('mouseout', (event) => {
            const input = event.target.closest(inputSelector);
            if (!input || !container.contains(input)) return;
            hideImagePreview();
        });
    }

    function refreshImageInputPlaceholders(container, inputSelector) {
        container.querySelectorAll(inputSelector).forEach((input, index) => {
            input.placeholder = index === 0 ? 'URL Κύριας Εικόνας' : 'Επιπλέον URL Εικόνας';
        });
    }

    imagePreviewElement.addEventListener('error', hideImagePreview);
    attachImagePreviewDelegation(addImageInputsContainer, '.add-image-input');
    attachImagePreviewDelegation(editImageInputsContainer, '.edit-image-input');

    /**
     * Whether a value is safe to persist as a product media URL.
     *
     * The image fields are plain <input type="url">, which accepts ANY
     * absolute URL including javascript: and data:. Those values are written
     * to Firestore and re-emitted into src/href on the storefront, so the
     * check belongs at the save boundary, not in the markup.
     */
    function isSafeMediaUrl(value) {
        const candidate = String(value || '').trim();
        if (!candidate) return false;
        try {
            const parsed = new URL(candidate, window.location.origin);
            return parsed.protocol === 'https:' || parsed.protocol === 'http:';
        } catch (_error) {
            return false;
        }
    }

    // Product Image Upload Elements
    const addProductImageFileInput = document.getElementById('add-product-image-file');
    const addProductImageUrlHidden = document.getElementById('add-product-image-url');
    const addProductImageStatus = document.getElementById('add-product-image-status');
    const addProductImagePreviewWrap = document.getElementById('add-product-image-preview-wrap');

    const editProductImageFileInput = document.getElementById('edit-product-image-file');
    const editProductImageUrlHidden = document.getElementById('edit-product-image-url');
    const editProductImageStatus = document.getElementById('edit-product-image-status');
    const editProductImagePreviewWrap = document.getElementById('edit-product-image-preview-wrap');

    // Featured Toggles
    const addIsFeaturedToggle = document.getElementById('add-is-featured');
    const editIsFeaturedToggle = document.getElementById('edit-is-featured');

    // Search and Sort Elements
    const productSearchInput = document.getElementById('product-search-input');
    const sortableHeaders = document.querySelectorAll('th[data-sort]');

    // Variations State & Elements (Add)
    let addSizes = [];
    let addColors = [];
    const addHasSizesToggle = document.getElementById('add-has-sizes');
    const addSizesContainer = document.getElementById('add-sizes-container');
    const addSizeInput = document.getElementById('add-size-input');
    const addSizesChipArea = document.getElementById('add-sizes-chip-area');

    const addHasColorsToggle = document.getElementById('add-has-colors');
    const addColorsContainer = document.getElementById('add-colors-container');
    const addColorInput = document.getElementById('add-color-input');
    const addColorsChipArea = document.getElementById('add-colors-chip-area');

    // Variations State & Elements (Edit)
    let editSizes = [];
    let editColors = [];
    const editHasSizesToggle = document.getElementById('edit-has-sizes');
    const editSizesContainer = document.getElementById('edit-sizes-container');
    const editSizeInput = document.getElementById('edit-size-input');
    const editSizesChipArea = document.getElementById('edit-sizes-chip-area');

    const editHasColorsToggle = document.getElementById('edit-has-colors');
    const editColorsContainer = document.getElementById('edit-colors-container');
    const editColorInput = document.getElementById('edit-color-input');
    const editColorsChipArea = document.getElementById('edit-colors-chip-area');

    // State Variables
    let productsList = [];
    let productSearchTerm = '';
    let productSortColumn = null;
    let productSortDirection = 'asc';

    // The Products tab used to re-read EVERY product document (parents and
    // variations) on dashboard load — while the tab was hidden — on every
    // tab click, and after every single save. The list in memory is now
    // reused for this long; saves refresh only the product they touched.
    const PRODUCTS_TAB_MAX_AGE_MS = 5 * 60 * 1000;
    let productsLoadedAt = 0;

    // ==========================================
    // CATALOG SNAPSHOT (write side) — read side: public/js/catalog-snapshot.js
    // ==========================================
    // settings/catalog: every active non-variation product + its active
    // variations, reduced to the fields the storefront listings render
    // (homepage, collection pages, search dropdown, related products). One
    // document read replaces one read per product for every first-time
    // visitor. Published from a complete fresh list (fetchProducts), patched
    // per product family after a save, and stock-patched server-side after
    // every sale (server/lib/catalog-snapshot.js). settings/{doc} is already
    // public-read / admin-write in firestore.rules — no rule change needed.
    const catalogSnapshotRef = doc(db, 'settings', 'catalog');
    // Firestore's hard limit is 1 MiB per document; keep a margin. Measured
    // with Firestore's own storage-size formula (see catalogByteSize).
    const CATALOG_SNAPSHOT_MAX_BYTES = 900 * 1024;
    const CATALOG_DESCRIPTION_FALLBACK_CHARS = 300;
    // v2 additions: the sale fields (a simple product's `salePrice`, a variable
    // product's stored `listingPrice` / `listingCompareAtPrice`) and, per
    // variation, its own `price` and `salePrice` — the storefront prices every
    // card, search suggestion and wishlist entry from these. The original
    // creation time is added by buildCatalogProducts() as `createdAtMs`.
    const CATALOG_PRODUCT_FIELDS = [
        'type', 'title', 'price', 'salePrice', 'listingPrice', 'listingCompareAtPrice',
        'stock', 'sku', 'image', 'hoverImage',
        'categories', 'category', 'subcategoryId', 'brand', 'isFeatured', 'variation_attributes',
        'colors', 'sizes', 'ratingSum', 'ratingCount'
    ];
    const CATALOG_VARIATION_FIELDS = [
        'price', 'salePrice', 'stock', 'attributes_map', 'attribute_terms', 'color', 'size', 'color_id', 'size_id'
    ];
    let lastPublishedCatalogSignature = null;
    // True only while productsList is a complete read answered by the server.
    // getDocs() may answer from the SDK's local cache when the browser is
    // offline — only the documents some listener kept, i.e. part of the
    // catalogue — and a snapshot built from that would drop every other
    // product from the storefront.
    let productsListFromServer = false;

    function pickCatalogFields(source, fields) {
        const picked = {};
        fields.forEach(field => {
            const value = source[field];
            if (value !== undefined && value !== null) picked[field] = value;
        });
        return picked;
    }

    // The collection page searches descriptions as text; tags and entities
    // only cost bytes. Tags become spaces (so "</p><p>" never glues two words
    // together), then DOMParser decodes the entities — it never executes
    // scripts or loads resources.
    function toPlainText(value) {
        if (typeof value !== 'string' || !value) return '';
        const withoutTags = value.replace(/<[^>]*>/g, ' ');
        let text;
        try {
            text = new DOMParser().parseFromString(withoutTags, 'text/html').documentElement.textContent || '';
        } catch (_error) {
            text = withoutTags;
        }
        return text.replace(/\s+/g, ' ').trim();
    }

    // Firestore's default order (document id) — the order every storefront
    // query returned, so pages, "load more" cursors and the related-products
    // pool come out exactly as before.
    function byDocumentId(first, second) {
        if (first.id < second.id) return -1;
        return first.id > second.id ? 1 : 0;
    }

    function buildCatalogProducts(list) {
        const variationsByParent = new Map();
        list.forEach(item => {
            if (!item || item.type !== 'variation' || item.status !== 'active') return;
            if (typeof item.parent_id !== 'string' || !item.parent_id) return;
            if (!variationsByParent.has(item.parent_id)) variationsByParent.set(item.parent_id, []);
            variationsByParent.get(item.parent_id).push({ id: item.id, ...pickCatalogFields(item, CATALOG_VARIATION_FIELDS) });
        });

        // Same membership as the storefront queries: status == 'active', every
        // type except 'variation' (the homepage also shows legacy type-less
        // products; the other pages filter to simple/variable themselves).
        return list
            .filter(item => item && item.status === 'active' && item.type !== 'variation')
            .map(item => {
                const entry = { id: item.id, ...pickCatalogFields(item, CATALOG_PRODUCT_FIELDS) };
                // ORIGINAL creation time as plain milliseconds (a Timestamp does
                // not survive JSON/localStorage as one). Products created
                // before `createdAt` existed simply have none and sort as the
                // oldest; edits never write createdAt, so it never moves.
                const createdAtMs = timestampToMillis(item.createdAt);
                if (createdAtMs !== null) entry.createdAtMs = createdAtMs;
                const description = toPlainText(item.description || item.desc || '');
                if (description) entry.description = description;
                if (item.type === 'variable') {
                    entry.variations = (variationsByParent.get(item.id) || []).sort(byDocumentId);
                }
                return entry;
            })
            .sort(byDocumentId);
    }

    // Firestore storage size, per https://firebase.google.com/docs/firestore/storage-size:
    // a string is its UTF-8 bytes + 1, a number 8, a boolean or null 1, an
    // array the sum of its values, and a map the sum of its keys and values
    // plus — read literally, "calculated the same way as document size" — 32
    // bytes. The map overhead is counted: this document is mostly small maps
    // (one per product and one per variation), and under that reading JSON
    // length undercounts a variation-heavy catalogue by about a quarter, so a
    // snapshot measured under the cap in JSON could still be rejected at the
    // 1 MiB document limit. (A rejected write retires the snapshot anyway —
    // see retireCatalogSnapshot — so erring high only costs snapshot reach.)
    const FIRESTORE_MAP_OVERHEAD_BYTES = 32;
    // Document name (settings/catalog) and the fields beside `products`.
    const CATALOG_DOCUMENT_OVERHEAD_BYTES = 256;
    const catalogSizeEncoder = new TextEncoder();

    function firestoreStringSize(value) {
        return catalogSizeEncoder.encode(value).length + 1;
    }

    function firestoreValueSize(value) {
        if (value === null || value === undefined || typeof value === 'boolean') return 1;
        if (typeof value === 'number') return 8;
        if (typeof value === 'string') return firestoreStringSize(value);
        if (Array.isArray(value)) return value.reduce((total, item) => total + firestoreValueSize(item), 0);
        if (typeof value === 'object') {
            if (typeof value.toMillis === 'function') return 8; // Timestamp
            return Object.keys(value).reduce(
                (total, key) => total + firestoreStringSize(key) + firestoreValueSize(value[key]),
                FIRESTORE_MAP_OVERHEAD_BYTES
            );
        }
        return 8;
    }

    function catalogByteSize(products) {
        return CATALOG_DOCUMENT_OVERHEAD_BYTES + firestoreValueSize(products);
    }

    /** Fits the list under the document limit, shortening descriptions last. */
    function fitCatalogProducts(products) {
        if (catalogByteSize(products) <= CATALOG_SNAPSHOT_MAX_BYTES) return products;

        const shortened = products.map(entry => (entry.description && entry.description.length > CATALOG_DESCRIPTION_FALLBACK_CHARS
            ? { ...entry, description: entry.description.slice(0, CATALOG_DESCRIPTION_FALLBACK_CHARS) }
            : entry));
        if (catalogByteSize(shortened) <= CATALOG_SNAPSHOT_MAX_BYTES) {
            console.warn(`[admin-products] Catalog snapshot is large: descriptions shortened to ${CATALOG_DESCRIPTION_FALLBACK_CHARS} characters for collection search.`);
            return shortened;
        }

        const withoutText = products.map(({ description, ...entry }) => entry);
        if (catalogByteSize(withoutText) <= CATALOG_SNAPSHOT_MAX_BYTES) {
            console.warn('[admin-products] Catalog snapshot is large: descriptions left out (collection search matches titles and SKUs only).');
            return withoutText;
        }

        console.warn('[admin-products] Catalog is too large for one snapshot document; the storefront keeps using live queries.');
        return null;
    }

    function buildCatalogPayload(products) {
        const fitted = fitCatalogProducts(products);
        return fitted
            ? { v: CATALOG_SNAPSHOT_VERSION, products: fitted, count: fitted.length, builtAt: serverTimestamp() }
            // products: null tells every storefront page to use its live query.
            : { v: CATALOG_SNAPSHOT_VERSION, products: null, count: products.length, reason: 'too_large', builtAt: serverTimestamp() };
    }

    /**
     * A snapshot write the backend REJECTS (invalid-argument — in practice the
     * 1 MiB document limit) used to leave the PREVIOUS snapshot live on every
     * storefront page: new products missing, deleted or hidden ones still
     * listed, old prices. It is replaced with the marker the storefront
     * already understands (products: null = use the live queries). Transient
     * failures (offline, unavailable) keep the previous copy, as before.
     */
    async function retireCatalogSnapshot(count) {
        try {
            await setDoc(catalogSnapshotRef, {
                v: CATALOG_SNAPSHOT_VERSION,
                products: null,
                count,
                reason: 'write_rejected',
                builtAt: serverTimestamp()
            });
            lastPublishedCatalogSignature = null;
        } catch (markerError) {
            console.error('[admin-products] Could not retire the rejected catalog snapshot.', markerError);
        }
    }

    /** Full rebuild from a complete, freshly read productsList. */
    async function publishCatalogSnapshot() {
        // Never from a list the SDK answered out of its offline cache.
        if (!productsListFromServer) return;
        const payload = buildCatalogPayload(buildCatalogProducts(productsList));
        const signature = JSON.stringify(payload.products);
        // Tab re-opens with nothing changed cost no write.
        if (signature === lastPublishedCatalogSignature) return;
        try {
            await setDoc(catalogSnapshotRef, payload);
            lastPublishedCatalogSignature = signature;
        } catch (error) {
            console.error('[admin-products] Catalog snapshot publish failed; the storefront keeps its previous copy (or its live queries).', error);
            if (error?.code === 'invalid-argument') await retireCatalogSnapshot(payload.count);
        }
    }

    /**
     * Replaces only the given product families inside the published snapshot
     * (1 read + 1 write). Every other entry keeps the snapshot's own values —
     * including stock the server patched after sales since this list was read.
     */
    async function patchCatalogSnapshot(parentIds) {
        const ids = new Set(parentIds.filter(Boolean));
        if (ids.size === 0) return;
        let attemptedCount = 0;
        try {
            await runTransaction(db, async (transaction) => {
                const snap = await transaction.get(catalogSnapshotRef);
                const current = snap.exists() ? snap.data() : null;
                const family = productsList.filter(item => ids.has(item.id) || ids.has(item.parent_id));
                const currentIsUsable = Boolean(current)
                    && current.v === CATALOG_SNAPSHOT_VERSION
                    && Array.isArray(current.products);
                // Without a usable snapshot the whole catalogue is rebuilt from
                // productsList, which must then be a complete server read.
                if (!currentIsUsable && !productsListFromServer) return;
                const products = currentIsUsable
                    ? current.products.filter(entry => !ids.has(entry.id)).concat(buildCatalogProducts(family)).sort(byDocumentId)
                    : buildCatalogProducts(productsList);
                attemptedCount = products.length;
                transaction.set(catalogSnapshotRef, buildCatalogPayload(products));
            });
            // The document now differs from the last full publish.
            lastPublishedCatalogSignature = null;
        } catch (error) {
            console.error('[admin-products] Catalog snapshot patch failed; it is repaired by the next Products refresh.', error);
            // Rejected (not merely failed): the live snapshot would keep
            // showing what this save changed — e.g. a deleted product.
            if (error?.code === 'invalid-argument') await retireCatalogSnapshot(attemptedCount);
        }
    }

    /**
     * Re-reads ONE product and its variations (1 + N reads instead of the whole
     * collection), splices them into productsList in document-id order — the
     * order a full fetch returns — repaints, and patches the snapshot.
     */
    async function refreshProductFamily(parentId) {
        try {
            const [parentSnap, childrenSnap] = await Promise.all([
                getDoc(doc(db, "products", parentId)),
                getDocs(query(collection(db, "products"), where("parent_id", "==", parentId)))
            ]);
            const family = [];
            if (parentSnap.exists()) family.push({ id: parentSnap.id, ...parentSnap.data() });
            childrenSnap.forEach(childSnap => family.push({ id: childSnap.id, ...childSnap.data() }));

            productsList = productsList
                .filter(item => item.id !== parentId && item.parent_id !== parentId)
                .concat(family)
                .sort(byDocumentId);
            renderProductsTable();
            await patchCatalogSnapshot([parentId]);
        } catch (error) {
            console.error('[admin-products] Targeted refresh failed; reloading the whole list.', error);
            await fetchProducts();
        }
    }

    // ==========================================
    // QUILL RICH TEXT EDITORS
    // ==========================================
    // Two independent instances are required: Quill binds to a single
    // container element and cannot be re-pointed at another, so the inline
    // "New Product" form and the Edit modal each need their own.
    //
    // Quill is loaded from a CDN in admin.html and attaches itself to the
    // global scope, so it is referenced as a global here rather than imported.
    let quillAdd = null;
    let quillEdit = null;

    const QUILL_TOOLBAR = [
        [{ 'header': [2, 3, 4, false] }],
        ['bold', 'italic', 'underline'],
        [{ 'list': 'ordered' }, { 'list': 'bullet' }],
        [{ 'align': [] }],
        ['link'],
        ['clean']
    ];

    const RICH_TEXT_ALLOWED_TAGS = new Set([
        'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's',
        'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'a', 'span'
    ]);
    const RICH_TEXT_DROP_CONTENT_TAGS = new Set([
        'script', 'style', 'iframe', 'object', 'embed', 'svg', 'math',
        'template', 'form', 'input', 'button', 'textarea', 'select', 'option',
        // Parser-context tags. These change how the *rest* of the markup is
        // tokenised, which is the raw material of mutation-XSS: a payload that
        // looks like inert text to a walker over the parsed tree can re-parse
        // as live markup once the sanitized output is re-serialised and
        // re-inserted. Dropping them with their contents removes the class.
        'noscript', 'noembed', 'noframes', 'xmp', 'plaintext', 'listing',
        'frameset', 'frame', 'base', 'link', 'meta', 'title', 'head',
        'audio', 'video', 'source', 'track', 'canvas', 'applet', 'marquee'
    ]);

    // Depth cap for the recursive walk. A description with a few thousand
    // nested tags (trivial to paste, trivial to store) would otherwise blow
    // the stack inside the sanitizer and, because the throw happens mid-save,
    // take the whole product write with it.
    const RICH_TEXT_MAX_DEPTH = 40;
    const QUILL_ALIGNMENT_CLASSES = new Set([
        'ql-align-center',
        'ql-align-right',
        'ql-align-justify'
    ]);

    function isSafeRichTextUrl(value) {
        try {
            const parsedUrl = new URL(value, window.location.origin);
            return ['http:', 'https:', 'mailto:', 'tel:'].includes(parsedUrl.protocol);
        } catch (_error) {
            return false;
        }
    }

    /**
     * Sanitizes Quill HTML with a narrow allowlist before it reaches Firestore.
     * List markup and Quill alignment output are retained, while executable
     * elements, event handlers, unsafe URLs and unrelated CSS are discarded.
     */
    function sanitizeRichText(html) {
        if (typeof html !== 'string' || html.trim() === '') return '';

        const parsedDocument = new DOMParser().parseFromString(html, 'text/html');

        const sanitizeChildren = (parent, depth = 0) => {
            if (depth > RICH_TEXT_MAX_DEPTH) {
                parent.textContent = parent.textContent;
                return;
            }

            Array.from(parent.childNodes).forEach((node) => {
                if (node.nodeType === Node.COMMENT_NODE) {
                    node.remove();
                    return;
                }

                if (node.nodeType === Node.TEXT_NODE) return;

                if (node.nodeType !== Node.ELEMENT_NODE) {
                    node.remove();
                    return;
                }

                const tagName = node.tagName.toLowerCase();

                if (RICH_TEXT_DROP_CONTENT_TAGS.has(tagName)) {
                    node.remove();
                    return;
                }

                if (!RICH_TEXT_ALLOWED_TAGS.has(tagName)) {
                    sanitizeChildren(node, depth + 1);
                    node.replaceWith(...Array.from(node.childNodes));
                    return;
                }

                const attributes = new Map(
                    Array.from(node.attributes, (attribute) => [attribute.name.toLowerCase(), attribute.value])
                );
                Array.from(node.attributes).forEach((attribute) => node.removeAttribute(attribute.name));

                const className = (attributes.get('class') || '').trim().replace(/\s+/g, ' ');
                if (QUILL_ALIGNMENT_CLASSES.has(className)) {
                    node.setAttribute('class', className);
                }

                const styleValue = attributes.get('style') || '';
                const textAlignMatch = styleValue.match(/(?:^|;)\s*text-align\s*:\s*(center|right|justify)\s*(?:;|$)/i);
                if (textAlignMatch) {
                    node.setAttribute('style', `text-align: ${textAlignMatch[1].toLowerCase()};`);
                }

                if (tagName === 'a') {
                    const href = (attributes.get('href') || '').trim();
                    if (href && isSafeRichTextUrl(href)) {
                        node.setAttribute('href', href);
                        if ((attributes.get('target') || '').toLowerCase() === '_blank') {
                            node.setAttribute('target', '_blank');
                            node.setAttribute('rel', 'noopener noreferrer');
                        }
                    }
                }

                sanitizeChildren(node, depth + 1);
            });
        };

        sanitizeChildren(parsedDocument.body);
        return parsedDocument.body.innerHTML.trim();
    }

    function initQuillEditors() {
        if (typeof Quill === 'undefined') {
            console.error('[admin-products] Quill did not load. Check the CDN tags in admin.html.');
            return;
        }

        const addContainer = document.getElementById('add-description-editor');
        const editContainer = document.getElementById('edit-description-editor');

        if (addContainer && !quillAdd) {
            quillAdd = new Quill(addContainer, {
                theme: 'snow',
                placeholder: 'Εισάγετε περιγραφή...',
                modules: { toolbar: QUILL_TOOLBAR }
            });
        }

        if (editContainer && !quillEdit) {
            quillEdit = new Quill(editContainer, {
                theme: 'snow',
                placeholder: 'Εισάγετε περιγραφή...',
                modules: { toolbar: QUILL_TOOLBAR }
            });
        }
    }

    /**
     * Reads a Quill instance's HTML for persistence.
     *
     * Quill never reports an empty editor as an empty string — it always holds
     * at least "<p><br></p>". Written to Firestore unchecked, that sentinel
     * makes every description look non-empty downstream, so the storefront
     * would render an empty block instead of its "no description" fallback.
     * Normalising to '' here is what keeps that fallback reachable.
     */
    function getQuillHTML(quillInstance) {
        if (!quillInstance) return '';
        return quillInstance.getText().trim() === ''
            ? ''
            : sanitizeRichText(quillInstance.root.innerHTML);
    }

    function clearQuill(quillInstance) {
        if (quillInstance) quillInstance.setContents([]);
    }

    initQuillEditors();

    // ==========================================
    // DYNAMIC CATEGORIES FOR DROPDOWNS
    // ==========================================
    let productCategories = [];
    function renderSubcategoryOptions(prefix, selected = '') {
        const parent = document.getElementById(`${prefix}-category`).value;
        const select = document.getElementById(`${prefix}-subcategory`);
        const children = productCategories.find(c => c.name === parent)?.subcategories || [];
        select.innerHTML = '<option value="">—</option>' + children
            .filter(c => !c.archived || c.id === selected)
            .map(c => `<option value="${escapeHTML(c.id)}">${escapeHTML(c.name)}${c.archived ? ' (αρχειοθετημένη)' : ''}</option>`).join('');
        select.value = children.some(c => c.id === selected) ? selected : '';
    }
    function renderCategoryOptions(tree) {
        productCategories = tree;
        ['add', 'edit'].forEach(prefix => {
            const select = document.getElementById(`${prefix}-category`);
            const previous = select.value;
            const child = document.getElementById(`${prefix}-subcategory`).value;
            const options = tree.map(c => c.name);
            // Preserve a legacy category on existing products; the validator
            // permits it only when it is unchanged from the original record.
            if (previous && !options.includes(previous)) options.push(previous);
            select.innerHTML = '<option value="" disabled>Επιλέξτε Κατηγορία</option>' + options
                .map(name => `<option value="${escapeHTML(name)}">${escapeHTML(name)}</option>`).join('');
            select.value = previous;
            renderSubcategoryOptions(prefix, child);
        });
    }
    async function loadCategoriesForDropdowns() {
        try { renderCategoryOptions(await getCategoryTree()); }
        catch (error) { console.error('Categories unavailable', error); }
    }
    subscribeCategoryTree(renderCategoryOptions);
    ['add', 'edit'].forEach(prefix => document.getElementById(`${prefix}-category`)
        .addEventListener('change', () => renderSubcategoryOptions(prefix)));
    async function collectOptionalFields(prefix, previous) {
        // Re-read at save, rather than trusting a form that may have been open
        // while another admin archived a child. Stable IDs survive that race.
        const snap = await getDoc(doc(db, 'settings', 'categories'));
        if (snap.metadata.fromCache) throw new Error('Χρειάζεται σύνδεση για την επικύρωση κατηγοριών.');
        return optionalProductFields(categoryTree(snap.data()?.list),
            document.getElementById(`${prefix}-category`).value,
            document.getElementById(`${prefix}-subcategory`).value,
            document.getElementById(`${prefix}-brand`).value, { previous });
    }

    // Category validation and product writes share a transaction. If another
    // tab archives/deletes the selection between form validation and commit,
    // Firestore retries against the new tree and rejects the stale assignment.
    function taxonomyBatch(product, previous) {
        const operations = [];
        return {
            set: (ref, value) => operations.push(['set', ref, value]),
            update: (ref, value) => operations.push(['update', ref, value]),
            delete: ref => operations.push(['delete', ref]),
            commit: () => runTransaction(db, async transaction => {
                const snap = await transaction.get(doc(db, 'settings', 'categories'));
                optionalProductFields(categoryTree(snap.data()?.list), product.categories,
                    typeof product.subcategoryId === 'string' ? product.subcategoryId : '',
                    typeof product.brand === 'string' ? product.brand : '', { previous });
                operations.forEach(([method, ref, value]) => {
                    if (method === 'delete') transaction.delete(ref);
                    else transaction[method](ref, value);
                });
            })
        };
    }

    // ==========================================
    // DISCOUNTS (sale prices)
    // ==========================================
    // `price` stays the REGULAR price. A discount is stored beside it as
    // `salePrice`: the FINAL price in EUR. It is valid only when it is a
    // whole number of cents, greater than zero and strictly below the regular
    // price OF THE SAME DOCUMENT. A simple product keeps `salePrice` on the
    // product; a variable product keeps it on each variation (the parent is a
    // listing, not a SKU) and the parent additionally stores `listingPrice` /
    // `listingCompareAtPrice` — the lowest effective variation price and that
    // same variation's regular price — for pages that do not load variations
    // (social metadata). Removing a discount deletes the field.
    const SALE_PROBLEMS = {
        format: 'Μη έγκυρη τιμή έκπτωσης.',
        decimals: 'Η τιμή έκπτωσης μπορεί να έχει έως 2 δεκαδικά ψηφία.',
        zero: 'Η τιμή έκπτωσης πρέπει να είναι μεγαλύτερη από 0.',
        empty: 'Εισάγετε την τελική τιμή με έκπτωση ή απενεργοποιήστε την έκπτωση.'
    };

    function adminMoney(value) {
        return `€${Number(value || 0).toLocaleString('el-GR', { maximumFractionDigits: 2 })}`;
    }

    /**
     * Validates a typed sale price against ITS OWN regular price.
     * An empty field means "no discount". Returns { salePrice, error }.
     */
    function resolveSaleInput(regularPrice, saleRaw, label = '') {
        const text = String(saleRaw ?? '').trim();
        const prefix = label ? `${label}: ` : '';
        if (!text) return { salePrice: null, error: null };

        const regularCents = toCents(regularPrice);
        if (regularCents === null || regularCents <= 0) {
            return { salePrice: null, error: `${prefix}Ορίστε πρώτα έγκυρη κανονική τιμή.` };
        }

        const parsed = parseEuroInput(text);
        if (!parsed.ok) {
            return { salePrice: null, error: `${prefix}${SALE_PROBLEMS[parsed.reason] || SALE_PROBLEMS.format}` };
        }
        if (parsed.cents >= regularCents) {
            return {
                salePrice: null,
                error: `${prefix}Η τιμή έκπτωσης (${adminMoney(parsed.value)}) πρέπει να είναι μικρότερη από την κανονική τιμή (${adminMoney(regularCents / 100)}).`
            };
        }
        return { salePrice: parsed.value, error: null };
    }

    /** Live feedback under a sale field: "-15% (€123 → €104)" or the problem. */
    function describeSale(regularPrice, saleRaw) {
        const text = String(saleRaw ?? '').trim();
        if (!text) return { text: '', isError: false };
        const result = resolveSaleInput(regularPrice, text);
        if (result.error) return { text: result.error, isError: true };
        const regularCents = toCents(regularPrice);
        const percent = getDiscountPercent(regularCents, toCents(result.salePrice));
        return { text: `-${percent}%  (${adminMoney(regularCents / 100)} → ${adminMoney(result.salePrice)})`, isError: false };
    }

    function paintHint(element, description) {
        if (!element) return;
        element.textContent = description.text;
        element.classList.toggle('text-red-600', description.isError);
        element.classList.toggle('text-neutral-500', !description.isError);
    }

    // True while that form has a variations table (the product is variable).
    const discountVariationMode = { add: false, edit: false };

    function refreshDiscountUI(prefix) {
        const toggle = document.getElementById(`${prefix}-has-discount`);
        const block = document.getElementById(`${prefix}-discount-block`);
        const fields = document.getElementById(`${prefix}-discount-fields`);
        const saleInput = document.getElementById(`${prefix}-sale-price`);
        const hint = document.getElementById(`${prefix}-discount-hint`);
        const note = document.getElementById(`${prefix}-discount-variable-note`);
        if (!toggle || !block || !fields || !saleInput) return;

        const variable = discountVariationMode[prefix] === true;
        const enabled = toggle.checked && !variable;

        block.classList.toggle('hidden', variable);
        if (note) note.classList.toggle('hidden', !variable);
        fields.classList.toggle('hidden', !enabled);
        // A disabled control is skipped by the browser's own form validation,
        // so a hidden sale field can never block saving.
        saleInput.disabled = !enabled;
        saleInput.required = enabled;

        if (!enabled) {
            paintHint(hint, { text: '', isError: false });
            return;
        }
        paintHint(hint, describeSale(document.getElementById(`${prefix}-price`)?.value, saleInput.value));
    }

    /** Puts a form's discount control into a known state (prefill / reset). */
    function setDiscountState(prefix, salePrice) {
        const toggle = document.getElementById(`${prefix}-has-discount`);
        const saleInput = document.getElementById(`${prefix}-sale-price`);
        if (!toggle || !saleInput) return;
        const hasSale = Number.isFinite(salePrice) && salePrice > 0;
        toggle.checked = hasSale;
        saleInput.value = hasSale ? String(salePrice) : '';
        refreshDiscountUI(prefix);
    }

    ['add', 'edit'].forEach(prefix => {
        document.getElementById(`${prefix}-has-discount`)?.addEventListener('change', () => {
            refreshDiscountUI(prefix);
            if (document.getElementById(`${prefix}-has-discount`).checked) {
                document.getElementById(`${prefix}-sale-price`)?.focus();
            }
        });
        document.getElementById(`${prefix}-sale-price`)?.addEventListener('input', () => refreshDiscountUI(prefix));
        document.getElementById(`${prefix}-price`)?.addEventListener('input', () => refreshDiscountUI(prefix));
    });

    // Per-variation live hint (one delegated listener per table container).
    function refreshVariationRowHint(row) {
        if (!row) return;
        const hint = row.querySelector('.var-discount-hint');
        if (!hint) return;
        const regular = parseFloat(row.querySelector('.var-price')?.value);
        paintHint(hint, describeSale(regular, row.querySelector('.var-sale-price')?.value));
    }

    ['add-variations-table-container', 'edit-variations-table-container'].forEach(containerId => {
        document.getElementById(containerId)?.addEventListener('input', (event) => {
            if (event.target.closest('.var-price, .var-sale-price')) {
                refreshVariationRowHint(event.target.closest('.variation-row'));
            }
        });
    });

    // ==========================================
    // CARTESIAN PRODUCT & TABLE GENERATOR
    // ==========================================
    // Cartesian ceiling. 400 combinations plus the parent still fits inside a
    // single 500-operation Firestore batch.
    const MAX_VARIATIONS = 400;

    // Sticky flags, one per form. When the projected combination count is over
    // the ceiling the table renders nothing — and an empty table is
    // indistinguishable, at submit time, from "this product has no variations
    // any more", which is exactly how the edit form used to DELETE every
    // existing variation of an over-sized product. The flags let both submit
    // handlers refuse instead of destroying data.
    let addVariationLimitExceeded = false;
    let editVariationLimitExceeded = false;

    function generateVariationCombinations(colors, sizes) {
        // Guard against massive Cartesian products that would exceed Firestore
        // batch limits. Reported through the returned marker rather than an
        // alert(): this runs on every debounced keystroke, and a modal alert
        // per character is unusable.
        const projected = (colors.length || 1) * (sizes.length || 1);
        if (projected > MAX_VARIATIONS) {
            return { limitExceeded: true, projected, combinations: [] };
        }

        let combinations = [];
        
        if (colors.length > 0 && sizes.length > 0) {
            colors.forEach(color => {
                sizes.forEach(size => {
                    combinations.push({ color, size });
                });
            });
        } else if (colors.length > 0) {
            colors.forEach(color => combinations.push({ color, size: null }));
        } else if (sizes.length > 0) {
            sizes.forEach(size => combinations.push({ color: null, size }));
        }
        
        return { limitExceeded: false, projected, combinations };
    }

    function generateVariationSKU(baseSku, color, size) {
        let sku = baseSku ? baseSku.trim() : 'SKU';
        if (color) {
            sku += `_${color.toLowerCase().replace(/\s+/g, '')}`;
        }
        if (size) {
            sku += `_n${size.toLowerCase().replace(/\s+/g, '')}`;
        }
        return sku;
    }

    function renderVariationsTable(containerId, baseSkuId, basePriceId, colors, sizes, existingVariations = []) {
        const container = document.getElementById(containerId);
        if (!container) return;

        const baseSku = document.getElementById(baseSkuId).value;
        const basePrice = parseFloat(document.getElementById(basePriceId).value) || 0;
        
        const { limitExceeded, projected, combinations } = generateVariationCombinations(colors, sizes);
        const isEditForm = containerId === 'edit-variations-table-container';

        // The sale price an admin has already typed into a row survives the
        // table being rebuilt (a chip added, the base price edited).
        const typedSalePrices = new Map();
        container.querySelectorAll('.variation-row').forEach(row => {
            typedSalePrices.set(
                `${row.getAttribute('data-color') || ''}|${row.getAttribute('data-size') || ''}`,
                row.querySelector('.var-sale-price')?.value ?? ''
            );
        });

        // A product with variations takes its discounts per variation.
        discountVariationMode[isEditForm ? 'edit' : 'add'] = limitExceeded || combinations.length > 0;
        refreshDiscountUI(isEditForm ? 'edit' : 'add');

        if (isEditForm) {
            editVariationLimitExceeded = limitExceeded;
        } else {
            addVariationLimitExceeded = limitExceeded;
        }

        if (limitExceeded) {
            // Visible, persistent, and impossible to mistake for "no variations".
            container.innerHTML = `
                <div class="mt-6 p-4 border border-red-200 bg-red-50 text-red-700 font-sans text-sm rounded-sm">
                    Ζητήθηκαν ${projected} παραλλαγές — το όριο είναι ${MAX_VARIATIONS}.
                    Μειώστε τα χρώματα ή τα μεγέθη. Η αποθήκευση είναι απενεργοποιημένη
                    για να μην χαθούν οι υπάρχουσες παραλλαγές.
                </div>
            `;
            return;
        }

        if (combinations.length === 0) {
            container.innerHTML = '';
            return;
        }

        let tableHTML = `
            <div class="overflow-x-auto border border-gray-200 rounded-sm mt-6">
                <table class="w-full text-left border-collapse">
                    <thead>
                        <tr class="bg-neutral-50 border-b border-gray-200 font-sans text-xs tracking-widest uppercase text-neutral-500">
                            <th class="p-3 font-medium">Παραλλαγή (Χρώμα / Μέγεθος)</th>
                            <th class="p-3 font-medium">SKU Παραλλαγής</th>
                            <th class="p-3 font-medium">Τιμή (€)</th>
                            <th class="p-3 font-medium">Τιμή Έκπτωσης (€)</th>
                            <th class="p-3 font-medium">Απόθεμα</th>
                            <th class="p-3 font-medium">Εικόνα (URL)</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y divide-gray-100">
        `;

        combinations.forEach((combo) => {
            const colorTermId = combo.color ? `term_color_${combo.color.toLowerCase().replace(/\s+/g, '')}` : null;
            const sizeTermId = combo.size ? `term_size_${combo.size.toLowerCase().replace(/\s+/g, '')}` : null;

            // Check if this combination already exists in the database
            const matchedVar = existingVariations.find(v => {
                const matchColor = (v.attributes_map?.attr_color || null) === colorTermId;
                const matchSize = (v.attributes_map?.attr_size || null) === sizeTermId;
                return matchColor && matchSize;
            });

            // Use existing data if found, otherwise fallback to generated/default data
            const generatedSku = matchedVar && matchedVar.sku ? matchedVar.sku : generateVariationSKU(baseSku, combo.color, combo.size);
            const rowPrice = matchedVar && matchedVar.price !== undefined ? matchedVar.price : basePrice;
            const rowStock = matchedVar && matchedVar.stock !== undefined ? matchedVar.stock : 0;
            const rowImage = matchedVar && matchedVar.image ? matchedVar.image : '';
            const rowKey = `${combo.color || ''}|${combo.size || ''}`;
            const storedSale = matchedVar && matchedVar.salePrice !== undefined && matchedVar.salePrice !== null
                ? String(matchedVar.salePrice)
                : '';
            const rowSale = typedSalePrices.has(rowKey) ? typedSalePrices.get(rowKey) : storedSale;
            const rowSaleHint = describeSale(parseFloat(rowPrice), rowSale);

            const labelText = [combo.color, combo.size].filter(Boolean).join(' / ');
            
            // FIX M1: Explicitly escape HTML for rowPrice and rowStock
            tableHTML += `
                <tr class="variation-row hover:bg-neutral-50 transition-colors" 
                    data-color="${escapeHTML(combo.color || '')}" 
                    data-size="${escapeHTML(combo.size || '')}">
                    <td class="p-3 font-sans text-sm text-neutral-900 font-medium">
                        ${escapeHTML(labelText)}
                    </td>
                    <td class="p-3">
                        <input type="text" class="var-sku w-full bg-transparent border-b border-gray-300 py-1 text-sm font-mono focus:outline-none focus:border-neutral-900" value="${escapeHTML(generatedSku)}">
                    </td>
                    <td class="p-3">
                        <input type="number" step="0.01" class="var-price w-24 bg-transparent border-b border-gray-300 py-1 text-sm focus:outline-none focus:border-neutral-900" value="${escapeHTML(String(rowPrice))}">
                    </td>
                    <td class="p-3">
                        <input type="number" min="0.01" step="0.01" class="var-sale-price w-24 bg-transparent border-b border-gray-300 py-1 text-sm focus:outline-none focus:border-neutral-900" placeholder="—" aria-label="Τιμή Έκπτωσης (€)" value="${escapeHTML(rowSale)}">
                        <p class="var-discount-hint font-sans text-[11px] mt-1 min-h-[0.875rem] ${rowSaleHint.isError ? 'text-red-600' : 'text-neutral-500'}">${escapeHTML(rowSaleHint.text)}</p>
                    </td>
                    <td class="p-3">
                        <input type="number" class="var-stock w-24 bg-transparent border-b border-gray-300 py-1 text-sm focus:outline-none focus:border-neutral-900" value="${escapeHTML(String(rowStock))}" data-original-stock="${matchedVar && matchedVar.stock !== undefined ? escapeHTML(String(Number(matchedVar.stock) || 0)) : ''}" min="0">
                    </td>
                    <td class="p-3">
                        <input type="url" class="var-image w-full bg-transparent border-b border-gray-300 py-1 text-sm focus:outline-none focus:border-neutral-900" placeholder="Προεπιλογή" value="${escapeHTML(rowImage)}">
                    </td>
                </tr>
            `;
        });

        tableHTML += `
                    </tbody>
                </table>
            </div>
        `;

        container.innerHTML = tableHTML;
    }

    function triggerAddTableUpdate() {
        renderVariationsTable('add-variations-table-container', 'add-sku', 'add-price', addColors, addSizes, []);
    }

    function triggerEditTableUpdate() {
        const currentId = document.getElementById('edit-id').value;
        const existingVariations = productsList.filter(p => p.type === 'variation' && p.parent_id === currentId);
        renderVariationsTable('edit-variations-table-container', 'edit-sku', 'edit-price', editColors, editSizes, existingVariations);
    }

    // FIX M3: Debounce wrapper to prevent UI thrashing on keystrokes
    function debounce(func, wait) {
        let timeout;
        return function(...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), wait);
        };
    }

    const triggerAddTableUpdateDebounced = debounce(triggerAddTableUpdate, 300);
    const triggerEditTableUpdateDebounced = debounce(triggerEditTableUpdate, 300);

    // Bind base SKU/Price changes to update tables with debounce
    document.getElementById('add-sku').addEventListener('input', triggerAddTableUpdateDebounced);
    document.getElementById('add-price').addEventListener('input', triggerAddTableUpdateDebounced);
    document.getElementById('edit-sku').addEventListener('input', triggerEditTableUpdateDebounced);
    document.getElementById('edit-price').addEventListener('input', triggerEditTableUpdateDebounced);


    // ==========================================
    // VARIATIONS (CHIPS) LOGIC
    // ==========================================
    function renderChips(array, container, inputElement, removeCallback) {
        const chips = container.querySelectorAll('.chip');
        chips.forEach(c => c.remove());

        array.forEach((item, index) => {
            const chip = document.createElement('span');
            chip.className = 'chip flex items-center gap-1 bg-stone-100 text-stone-800 px-2 py-1 rounded-sm text-xs font-sans border border-stone-200';
            chip.innerHTML = `
                ${escapeHTML(item)}
                <button type="button" class="text-stone-400 hover:text-red-500 focus:outline-none font-bold ml-1 leading-none" data-index="${index}">&times;</button>
            `;
            chip.querySelector('button').addEventListener('click', () => {
                removeCallback(index);
            });
            container.insertBefore(chip, inputElement);
        });
    }

    function handleChipInput(event, array, renderFn) {
        if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault();
            const val = event.target.value.trim().replace(/,/g, '');
            if (val && !array.includes(val)) {
                array.push(val);
                renderFn();
            }
            event.target.value = '';
        }
    }

    // Add Variation Listeners
    if (addHasSizesToggle) {
        addHasSizesToggle.addEventListener('change', (e) => {
            if (e.target.checked) {
                addSizesContainer.classList.remove('hidden');
                addSizesContainer.classList.add('flex');
            } else {
                addSizesContainer.classList.add('hidden');
                addSizesContainer.classList.remove('flex');
                addSizes = [];
                triggerAddTableUpdate();
            }
        });
    }

    function removeAddSize(idx) {
        addSizes.splice(idx, 1);
        renderChips(addSizes, addSizesChipArea, addSizeInput, removeAddSize);
        triggerAddTableUpdate();
    }

    if (addSizeInput) {
        addSizeInput.addEventListener('keydown', (e) => {
            handleChipInput(e, addSizes, () => {
                renderChips(addSizes, addSizesChipArea, addSizeInput, removeAddSize);
                triggerAddTableUpdate();
            });
        });
    }

    if (addHasColorsToggle) {
        addHasColorsToggle.addEventListener('change', (e) => {
            if (e.target.checked) {
                addColorsContainer.classList.remove('hidden');
                addColorsContainer.classList.add('flex');
            } else {
                addColorsContainer.classList.add('hidden');
                addColorsContainer.classList.remove('flex');
                addColors = [];
                triggerAddTableUpdate();
            }
        });
    }

    function removeAddColor(idx) {
        addColors.splice(idx, 1);
        renderChips(addColors, addColorsChipArea, addColorInput, removeAddColor);
        triggerAddTableUpdate();
    }

    if (addColorInput) {
        addColorInput.addEventListener('keydown', (e) => {
            handleChipInput(e, addColors, () => {
                renderChips(addColors, addColorsChipArea, addColorInput, removeAddColor);
                triggerAddTableUpdate();
            });
        });
    }

    // Edit Variation Listeners
    if (editHasSizesToggle) {
        editHasSizesToggle.addEventListener('change', (e) => {
            if (e.target.checked) {
                editSizesContainer.classList.remove('hidden');
                editSizesContainer.classList.add('flex');
            } else {
                editSizesContainer.classList.add('hidden');
                editSizesContainer.classList.remove('flex');
                editSizes = [];
                triggerEditTableUpdate();
            }
        });
    }

    function removeEditSize(idx) {
        editSizes.splice(idx, 1);
        renderChips(editSizes, editSizesChipArea, editSizeInput, removeEditSize);
        triggerEditTableUpdate();
    }

    if (editSizeInput) {
        editSizeInput.addEventListener('keydown', (e) => {
            handleChipInput(e, editSizes, () => {
                renderChips(editSizes, editSizesChipArea, editSizeInput, removeEditSize);
                triggerEditTableUpdate();
            });
        });
    }

    if (editHasColorsToggle) {
        editHasColorsToggle.addEventListener('change', (e) => {
            if (e.target.checked) {
                editColorsContainer.classList.remove('hidden');
                editColorsContainer.classList.add('flex');
            } else {
                editColorsContainer.classList.add('hidden');
                editColorsContainer.classList.remove('flex');
                editColors = [];
                triggerEditTableUpdate();
            }
        });
    }

    function removeEditColor(idx) {
        editColors.splice(idx, 1);
        renderChips(editColors, editColorsChipArea, editColorInput, removeEditColor);
        triggerEditTableUpdate();
    }

    if (editColorInput) {
        editColorInput.addEventListener('keydown', (e) => {
            handleChipInput(e, editColors, () => {
                renderChips(editColors, editColorsChipArea, editColorInput, removeEditColor);
                triggerEditTableUpdate();
            });
        });
    }

    // ==========================================
    // SEARCH & SORT LOGIC
    // ==========================================
    if (productSearchInput) {
        productSearchInput.addEventListener('input', (e) => {
            productSearchTerm = e.target.value.trim().toLowerCase();
            renderProductsTable();
        });
    }

    function updateSortIndicators() {
        sortableHeaders.forEach(header => {
            const col = header.getAttribute('data-sort');
            const indicator = header.querySelector('.sort-indicator');
            if (indicator) {
                if (col === productSortColumn) {
                    indicator.textContent = productSortDirection === 'asc' ? '↑' : '↓';
                } else {
                    indicator.textContent = '';
                }
            }
        });
    }

    sortableHeaders.forEach(header => {
        header.addEventListener('click', () => {
            const column = header.getAttribute('data-sort');
            if (productSortColumn === column) {
                productSortDirection = productSortDirection === 'asc' ? 'desc' : 'asc';
            } else {
                productSortColumn = column;
                productSortDirection = 'asc';
            }
            updateSortIndicators();
            renderProductsTable();
        });
    });

    // ==========================================
    // 4. PRODUCTS CRUD OPERATIONS
    // ==========================================
    /**
     * Full read of the products collection (one billed read per document).
     * `maxAgeMs` > 0 (tab activation) reuses the list in memory while it is
     * younger than that; callers that need a complete fresh list (CSV import,
     * a failed targeted refresh) call it with no argument.
     */
    async function fetchProducts({ maxAgeMs = 0 } = {}) {
        if (maxAgeMs > 0 && productsLoadedAt && Date.now() - productsLoadedAt < maxAgeMs) return;

        productsTableBody.innerHTML = `<tr><td colspan="7" class="p-8 text-center text-neutral-400">Φόρτωση προϊόντων...</td></tr>`;
        try {
            const querySnapshot = await getDocs(collection(db, "products"));
            productsList = [];
            querySnapshot.forEach((docSnap) => {
                productsList.push({ id: docSnap.id, ...docSnap.data() });
            });
            // Offline, getDocs() answers from the local cache: possibly only
            // part of the catalogue. Show it, but do not treat it as a fresh
            // list for the tab cache, and never publish it to the storefront.
            productsListFromServer = !(querySnapshot.metadata && querySnapshot.metadata.fromCache);
            productsLoadedAt = productsListFromServer ? Date.now() : 0;
            renderProductsTable();
            if (!productsListFromServer) {
                console.warn('[admin-products] Products came from the offline cache; the storefront catalog snapshot was not republished.');
            }
            // A complete, fresh list: republish the storefront snapshot (no
            // write when nothing changed since the last publish).
            void publishCatalogSnapshot();
        } catch (error) {
            console.error("Error fetching products:", error);
            productsTableBody.innerHTML = `<tr><td colspan="7" class="p-8 text-center text-red-500">Σφάλμα φόρτωσης προϊόντων.</td></tr>`;
        }
    }

    // Regular price struck through + current price + percentage while a
    // product (or, for a variable one, its cheapest variation) is discounted.
    function renderAdminPriceCell(product) {
        const listing = product.computedListing || resolveListingPrice(product);
        const prefix = product.type === 'variable' ? '<span class="text-neutral-400 text-xs font-normal mr-1">Από</span>' : '';
        if (!listing.onSale) {
            return `${prefix}${escapeHTML(adminMoney(listing.unit || product.price || 0))}`;
        }
        return `${prefix}<span class="text-neutral-400 line-through text-xs font-normal mr-1">${escapeHTML(adminMoney(listing.regular))}</span>`
            + `<span>${escapeHTML(adminMoney(listing.unit))}</span>`
            + `<span class="ml-2 px-1.5 py-0.5 bg-neutral-900 text-white rounded text-[10px] font-bold tracking-wider">-${listing.discountPercent}%</span>`;
    }

    function renderProductsTable() {
        // 1. Filter and Compute Total Stock
        let processedList = productsList.filter(p => {
            // Exclude child variations from the main admin table
            if (p.type === 'variation') return false;

            const titleMatch = (p.title || '').toLowerCase().includes(productSearchTerm);
            const skuMatch = (p.sku || '').toLowerCase().includes(productSearchTerm);
            return titleMatch || skuMatch;
        }).map(p => {
            if (p.type === 'variable') {
                const children = productsList.filter(v => v.type === 'variation' && v.parent_id === p.id);
                p.computedStock = children.reduce((sum, v) => sum + (Number(v.stock) || 0), 0);
                p.computedListing = resolveListingPrice({
                    ...p,
                    variations: children.filter(v => v.status === 'active')
                });
            } else {
                p.computedStock = Number(p.stock) || 0;
                p.computedListing = resolveListingPrice(p);
            }
            return p;
        });

        // 2. Sort
        if (productSortColumn) {
            processedList.sort((a, b) => {
                // Price sorts by what the customer pays (the sale price when
                // discounted), stock by the computed total.
                const columnValue = (product) => {
                    if (productSortColumn === 'stock') return product.computedStock;
                    if (productSortColumn === 'price') return product.computedListing.unit;
                    return Number(product[productSortColumn]) || 0;
                };
                let valA = columnValue(a);
                let valB = columnValue(b);

                if (valA < valB) return productSortDirection === 'asc' ? -1 : 1;
                if (valA > valB) return productSortDirection === 'asc' ? 1 : -1;
                return 0;
            });
        }

        // 3. Render
        if (processedList.length === 0) {
            productsTableBody.innerHTML = `<tr><td colspan="7" class="p-8 text-center text-neutral-400">Δεν βρέθηκαν προϊόντα.</td></tr>`;
            return;
        }

        productsTableBody.innerHTML = processedList.map(product => {
            const statusBadge = product.status === 'hidden'
                ? `<span class="px-2 py-1 bg-gray-200 text-gray-600 rounded text-[10px] uppercase font-bold tracking-wider">Κρυφό</span>`
                : `<span class="px-2 py-1 bg-green-100 text-green-800 rounded text-[10px] uppercase font-bold tracking-wider">Ενεργό</span>`;
                
            const stockBadge = product.type === 'variable'
                ? `<div class="flex items-center"><span class="whitespace-nowrap">${product.computedStock} τεμ</span><span class="px-2 py-1 bg-blue-100 text-blue-800 rounded text-xs font-bold ml-2">Παραλλαγές</span></div>`
                : product.computedStock <= 0
                    ? `<span class="px-2 py-1 bg-red-100 text-red-800 rounded text-xs font-bold">Εξαντλήθηκε</span>`
                    : `<span class="px-2 py-1 bg-gray-100 rounded text-xs">${product.computedStock} τεμ</span>`;

            return `
                <tr class="hover:bg-neutral-50 transition-colors border-b border-gray-100">
                    <td class="p-4">
                        <div class="flex items-center gap-4">
                            <div class="w-12 h-12 bg-gray-100 rounded-sm overflow-hidden flex-shrink-0">
                                <img src="${escapeHTML(product.image || '')}" alt="${escapeHTML(product.title)}" class="w-full h-full object-cover">
                            </div>
                            <span class="font-serif font-medium text-neutral-900">${escapeHTML(product.title)}</span>
                        </div>
                    </td>
                    <td class="p-4 text-neutral-500 font-mono text-xs">${escapeHTML(product.sku || 'N/A')}</td>
                    <td class="p-4 capitalize text-neutral-500">${escapeHTML(product.categories || 'N/A')}</td>
                    <td class="p-4 font-medium">${renderAdminPriceCell(product)}</td>
                    <td class="p-4">${stockBadge}</td>
                    <td class="p-4">${statusBadge}</td>
                    <td class="p-4 text-right space-x-3">
                        <button class="edit-product-btn text-neutral-400 hover:text-neutral-900 transition-colors underline underline-offset-4 text-xs tracking-widest uppercase" data-id="${escapeHTML(product.id)}">
                            Επεξεργασία
                        </button>
                        <button class="delete-product-btn text-red-400 hover:text-red-700 transition-colors underline underline-offset-4 text-xs tracking-widest uppercase" data-id="${escapeHTML(product.id)}">
                            Διαγραφή
                        </button>
                    </td>
                </tr>
            `;
        }).join('');
    }

    // Dynamic Image Inputs Logic
    addImageBtn.addEventListener('click', () => {
        const currentInputs = addImageInputsContainer.querySelectorAll('.add-image-input');
        if (currentInputs.length >= 10) {
            alert("Μέγιστο όριο 10 εικόνων.");
            return;
        }
        const inputHTML = `
            <div class="flex gap-2 items-center">
                <input type="url" required class="add-image-input w-full bg-transparent border-b border-gray-300 py-2 focus:outline-none focus:border-neutral-900" placeholder="Επιπλέον URL Εικόνας">
                <button type="button" class="text-red-400 hover:text-red-700 font-bold text-xl remove-image-btn">&times;</button>
            </div>
        `;
        addImageInputsContainer.insertAdjacentHTML('beforeend', inputHTML);
        refreshImageInputPlaceholders(addImageInputsContainer, '.add-image-input');
    });

    addImageInputsContainer.addEventListener('click', async (e) => {
        if (e.target.classList.contains('remove-image-btn')) {
            const inputEl = e.target.parentElement.querySelector('input');
            const imageUrl = inputEl ? inputEl.value.trim() : '';

            if (imageUrl && getCurrentUser()) {
                try {
                    const idToken = await getCurrentUser().getIdToken();
                    await fetch('/api/r2?action=delete-file', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${idToken}`
                        },
                        body: JSON.stringify({ url: imageUrl })
                    });
                } catch (err) {
                    console.warn('[admin] Failed to delete image from bucket on row removal:', err);
                }
            }
            e.target.parentElement.remove();
            refreshImageInputPlaceholders(addImageInputsContainer, '.add-image-input');
        }
    });

    editAddImageBtn.addEventListener('click', () => {
        const currentInputs = editImageInputsContainer.querySelectorAll('.edit-image-input');
        if (currentInputs.length >= 10) {
            alert("Μέγιστο όριο 10 εικόνων.");
            return;
        }
        const inputHTML = `
            <div class="flex gap-2 items-center">
                <input type="url" required class="edit-image-input w-full bg-transparent border-b border-gray-300 py-2 focus:outline-none focus:border-neutral-900" placeholder="Επιπλέον URL Εικόνας">
                <button type="button" class="text-red-400 hover:text-red-700 font-bold text-xl remove-image-btn">&times;</button>
            </div>
        `;
        editImageInputsContainer.insertAdjacentHTML('beforeend', inputHTML);
        refreshImageInputPlaceholders(editImageInputsContainer, '.edit-image-input');
    });

    editImageInputsContainer.addEventListener('click', async (e) => {
        if (e.target.classList.contains('remove-image-btn')) {
            const inputEl = e.target.parentElement.querySelector('input');
            const imageUrl = inputEl ? inputEl.value.trim() : '';

            if (imageUrl && getCurrentUser()) {
                try {
                    const idToken = await getCurrentUser().getIdToken();
                    await fetch('/api/r2?action=delete-file', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${idToken}`
                        },
                        body: JSON.stringify({ url: imageUrl })
                    });
                } catch (err) {
                    console.warn('[admin] Failed to delete image from bucket on row removal:', err);
                }
            }
            e.target.parentElement.remove();
            refreshImageInputPlaceholders(editImageInputsContainer, '.edit-image-input');
        }
    });

    // Product Media File Upload Integration
    const MAX_PRODUCT_MEDIA_BYTES = 50 * 1024 * 1024;
    const ALLOWED_PRODUCT_MEDIA_TYPES = new Set([
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/gif',
        'video/mp4',
        'video/webm'
    ]);

    async function readJsonResponse(response) {
        try {
            return await response.json();
        } catch (_error) {
            return {};
        }
    }

    function clearProductMediaPreview(previewWrap) {
        if (!previewWrap) return;
        previewWrap.replaceChildren();
        previewWrap.classList.add('hidden');
    }

    function renderProductMediaPreview(previewWrap, mediaUrl, mediaType) {
        if (!previewWrap) return;

        const isVideo = mediaType.startsWith('video/');
        const previewElement = document.createElement(isVideo ? 'video' : 'img');
        previewElement.src = mediaUrl;
        previewElement.className = 'w-28 h-28 object-contain rounded-sm border border-gray-200 bg-neutral-100';

        if (isVideo) {
            previewElement.setAttribute('autoplay', '');
            previewElement.setAttribute('muted', '');
            previewElement.setAttribute('loop', '');
            previewElement.setAttribute('playsinline', '');
            previewElement.muted = true;
            previewElement.setAttribute('aria-label', 'Προεπισκόπηση βίντεο προϊόντος');
        } else {
            previewElement.alt = 'Προεπισκόπηση εικόνας προϊόντος';
            previewElement.decoding = 'async';
        }

        previewWrap.replaceChildren(previewElement);
        previewWrap.classList.remove('hidden');
    }

    function assignUploadedMediaUrl(inputsContainer, inputSelector, addInputButton, mediaUrl) {
        const inputs = Array.from(inputsContainer.querySelectorAll(inputSelector));
        let targetInput = inputs.find(input => !input.value.trim() || input.value.trim().startsWith('data:'));

        if (!targetInput && inputs.length < 10) {
            addInputButton.click();
            const refreshedInputs = inputsContainer.querySelectorAll(inputSelector);
            targetInput = refreshedInputs[refreshedInputs.length - 1] || null;
        }

        if (!targetInput) {
            throw new Error('Έχει συμπληρωθεί το μέγιστο όριο των 10 πολυμέσων.');
        }

        targetInput.value = mediaUrl;
        targetInput.dispatchEvent(new Event('input', { bubbles: true }));
    }

    async function deleteUnregisteredProductMedia({ idToken, fileKey, fileId, fileSize }) {
        const cleanupResponse = await fetch('/api/r2?action=delete-file', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${idToken}`
            },
            body: JSON.stringify({ fileKey, fileId, fileSize })
        });

        if (!cleanupResponse.ok) {
            const cleanupData = await readJsonResponse(cleanupResponse);
            throw new Error(cleanupData.error || 'Αποτυχία καθαρισμού του μη καταγεγραμμένου αρχείου.');
        }
    }

    async function uploadProductMedia(file, {
        fileInput,
        statusElement,
        urlInput,
        previewWrap,
        inputsContainer,
        inputSelector,
        addInputButton
    }) {
        if (!ALLOWED_PRODUCT_MEDIA_TYPES.has(file.type)) {
            throw new Error('Μη υποστηριζόμενος τύπος αρχείου. Επιτρέπονται JPEG, PNG, WEBP, GIF, MP4 και WEBM.');
        }
        if (!Number.isFinite(file.size) || file.size <= 0) {
            throw new Error('Το αρχείο είναι κενό ή μη έγκυρο.');
        }
        if (file.size > MAX_PRODUCT_MEDIA_BYTES) {
            throw new Error('Το αρχείο υπερβαίνει τα 50MB.');
        }

        const currentUser = getCurrentUser();
        if (!currentUser) {
            throw new Error('Η συνεδρία σας έληξε. Συνδεθείτε ξανά.');
        }

        const currentMediaInputs = Array.from(inputsContainer.querySelectorAll(inputSelector));
        const hasAvailableMediaField = currentMediaInputs.some(input => {
            const value = input.value.trim();
            return !value || value.startsWith('data:');
        }) || currentMediaInputs.length < 10;

        if (!hasAvailableMediaField) {
            throw new Error('Έχει συμπληρωθεί το μέγιστο όριο των 10 πολυμέσων.');
        }

        statusElement.textContent = 'Προετοιμασία μεταφόρτωσης...';
        statusElement.className = 'font-sans text-xs text-neutral-500';
        fileInput.disabled = true;

        const idToken = await currentUser.getIdToken();
        const presignResponse = await fetch('/api/r2?action=product-media-url', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${idToken}`
            },
            body: JSON.stringify({
                fileName: file.name,
                fileType: file.type,
                fileSize: file.size
            })
        });
        const presignData = await readJsonResponse(presignResponse);

        if (!presignResponse.ok) {
            throw new Error(presignData.error || 'Δεν ήταν δυνατή η προετοιμασία της μεταφόρτωσης.');
        }
        if (!presignData.uploadUrl || !presignData.fileKey || !presignData.publicUrl) {
            throw new Error('Ο διακομιστής επέστρεψε ελλιπή στοιχεία μεταφόρτωσης.');
        }

        statusElement.textContent = 'Μεταφόρτωση...';
        const uploadResponse = await fetch(presignData.uploadUrl, {
            method: 'PUT',
            body: file,
            headers: {
                'Content-Type': file.type
            }
        });

        if (!uploadResponse.ok) {
            throw new Error(`Η μεταφόρτωση απέτυχε (κωδικός ${uploadResponse.status}).`);
        }

        statusElement.textContent = 'Καταγραφή χρήσης χώρου...';
        const usageRecordRef = doc(collection(db, 'users', currentUser.uid, 'cloud_drive_files'));

        try {
            await setDoc(usageRecordRef, {
                fileName: file.name,
                originalName: file.name,
                fileSize: file.size,
                fileKey: presignData.fileKey,
                url: presignData.publicUrl,
                contentType: file.type,
                type: 'product_image',
                createdAt: serverTimestamp(),
                uploadedAt: serverTimestamp()
            });
        } catch (recordError) {
            try {
                await deleteUnregisteredProductMedia({
                    idToken,
                    fileKey: presignData.fileKey,
                    fileId: usageRecordRef.id,
                    fileSize: file.size
                });
            } catch (cleanupError) {
                console.error('[admin-products] Failed to clean up unregistered product media:', cleanupError);
            }

            throw new Error('Το αρχείο μεταφορτώθηκε, αλλά δεν ήταν δυνατή η καταγραφή του αποθηκευτικού χώρου. Η μεταφόρτωση ακυρώθηκε.');
        }

        urlInput.value = presignData.publicUrl;
        renderProductMediaPreview(previewWrap, presignData.publicUrl, file.type);
        assignUploadedMediaUrl(inputsContainer, inputSelector, addInputButton, presignData.publicUrl);
        adjustStorageUsage(file.size);

        statusElement.textContent = 'Επιτυχής μεταφόρτωση!';
        statusElement.className = 'font-sans text-xs text-green-600';
    }

    function bindProductMediaUpload(fileInput, uploadOptions) {
        if (!fileInput) return;

        fileInput.addEventListener('change', async (event) => {
            const file = event.target.files && event.target.files[0];
            if (!file) return;

            try {
                await uploadProductMedia(file, { fileInput, ...uploadOptions });
            } catch (error) {
                console.error('[admin-products] Product media upload failed:', error);
                uploadOptions.statusElement.textContent = error.message || 'Αποτυχία μεταφόρτωσης.';
                uploadOptions.statusElement.className = 'font-sans text-xs text-red-500';
            } finally {
                fileInput.disabled = false;
                fileInput.value = '';
            }
        });
    }

    bindProductMediaUpload(addProductImageFileInput, {
        statusElement: addProductImageStatus,
        urlInput: addProductImageUrlHidden,
        previewWrap: addProductImagePreviewWrap,
        inputsContainer: addImageInputsContainer,
        inputSelector: '.add-image-input',
        addInputButton: addImageBtn
    });

    bindProductMediaUpload(editProductImageFileInput, {
        statusElement: editProductImageStatus,
        urlInput: editProductImageUrlHidden,
        previewWrap: editProductImagePreviewWrap,
        inputsContainer: editImageInputsContainer,
        inputSelector: '.edit-image-input',
        addInputButton: editAddImageBtn
    });

    // Toggle Add Product Form
    toggleAddProductBtn.addEventListener('click', () => {
        addProductContainer.classList.remove('hidden');
    });

    function resetAddProductUI() {
        addProductContainer.classList.add('hidden');
        addProductForm.reset();
        renderSubcategoryOptions('add');

        // form.reset() cannot clear Quill — its content lives in a
        // contenteditable div, not a form control — so it must be cleared
        // explicitly, or the next "New Product" opens pre-filled with the
        // previous product's description.
        clearQuill(quillAdd);
        
        // Reset Featured
        if (addIsFeaturedToggle) addIsFeaturedToggle.checked = false;

        // Reset the discount control (form.reset() cannot undo hidden/disabled).
        discountVariationMode.add = false;
        setDiscountState('add', null);

        // Reset Variations
        addHasSizesToggle.checked = false;
        addSizesContainer.classList.add('hidden');
        addSizesContainer.classList.remove('flex');
        addSizes = [];
        const sizeChips = addSizesChipArea.querySelectorAll('.chip');
        sizeChips.forEach(c => c.remove());

        addHasColorsToggle.checked = false;
        addColorsContainer.classList.add('hidden');
        addColorsContainer.classList.remove('flex');
        addColors = [];
        const colorChips = addColorsChipArea.querySelectorAll('.chip');
        colorChips.forEach(c => c.remove());
        
        document.getElementById('add-variations-table-container').innerHTML = '';

        // Reset Images
        addImageInputsContainer.innerHTML = `
            <div class="flex gap-2 items-center">
                <input type="url" required class="add-image-input w-full bg-transparent border-b border-gray-300 py-2 focus:outline-none focus:border-neutral-900" placeholder="URL Κύριας Εικόνας">
                <button type="button" class="text-red-400 hover:text-red-700 font-bold text-xl remove-image-btn">&times;</button>
            </div>
        `;
        if (addProductImageFileInput) {
            addProductImageFileInput.value = '';
            addProductImageUrlHidden.value = '';
            addProductImageStatus.textContent = '';
            addProductImageStatus.className = 'font-sans text-xs text-neutral-500';
            clearProductMediaPreview(addProductImagePreviewWrap);
        }
    }

    cancelAddBtn.addEventListener('click', async () => {
        if (addProductImageUrlHidden && addProductImageUrlHidden.value && getCurrentUser()) {
            try {
                const idToken = await getCurrentUser().getIdToken();
                await fetch('/api/r2?action=delete-file', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${idToken}`
                    },
                    body: JSON.stringify({ url: addProductImageUrlHidden.value })
                });
            } catch (err) {
                console.warn('Failed to delete orphaned image on cancel:', err);
            }
            addProductImageUrlHidden.value = '';
        }
        resetAddProductUI();
    });

    function parseVariationPrice(row) {
        const price = parseFloat(row.querySelector('.var-price')?.value);
        return Number.isFinite(price) && price >= 0 ? price : null;
    }

    function getMinimumVariationPrice(variationRows, fallbackPrice) {
        const validVariationPrices = Array.from(variationRows)
            .map(parseVariationPrice)
            .filter(price => price !== null);

        return validVariationPrices.length > 0
            ? Math.min(...validVariationPrices)
            : fallbackPrice;
    }

    /**
     * Reads and validates every sale price of one form (`prefix` = 'add' |
     * 'edit') BEFORE anything is written.
     *
     *   simple    -> the discount toggle + field (a regular price is required)
     *   variable  -> one optional sale field per variation row, each checked
     *                against that row's own regular price
     *
     * Returns { error } on the first problem, otherwise
     * { error: null, parentSalePrice, rowSales[], listing } where `listing` is
     * the lowest effective variation price with that same variation's regular
     * price (variable products only).
     */
    function collectSalePricing(prefix, productType, variationRows, basePrice, parentPrice) {
        if (productType === 'simple') {
            const enabled = document.getElementById(`${prefix}-has-discount`)?.checked === true;
            if (!enabled) return { error: null, parentSalePrice: null, rowSales: [], listing: null };

            const raw = document.getElementById(`${prefix}-sale-price`)?.value ?? '';
            if (!String(raw).trim()) return { error: SALE_PROBLEMS.empty };
            const result = resolveSaleInput(basePrice, raw);
            if (result.error) return { error: result.error };
            return { error: null, parentSalePrice: result.salePrice, rowSales: [], listing: null };
        }

        const rows = Array.from(variationRows);
        const rowSales = [];
        const pricedVariations = [];

        for (let index = 0; index < rows.length; index += 1) {
            const row = rows[index];
            const label = `Παραλλαγή «${[row.getAttribute('data-color'), row.getAttribute('data-size')].filter(Boolean).join(' / ')}»`;
            // Same fallback the save uses for a row with an empty price.
            const rowRegular = parseVariationPrice(row) ?? parentPrice;
            const result = resolveSaleInput(rowRegular, row.querySelector('.var-sale-price')?.value, label);
            if (result.error) return { error: result.error };

            rowSales.push(result.salePrice);
            pricedVariations.push({
                id: String(index).padStart(5, '0'),
                price: rowRegular,
                ...(result.salePrice !== null ? { salePrice: result.salePrice } : {})
            });
        }

        const listing = resolveListingPrice({ type: 'variable', variations: pricedVariations });
        return {
            error: null,
            parentSalePrice: null,
            rowSales,
            listing: listing.unit > 0
                ? { price: listing.unit, compareAtPrice: listing.onSale ? listing.regular : null }
                : null
        };
    }

    // Add New Product
    addProductForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        // Catch leftover inputs before processing arrays
        let needsTableUpdate = false;
        if (addHasSizesToggle.checked && addSizeInput && addSizeInput.value.trim() !== '') {
            const val = addSizeInput.value.trim().replace(/,/g, '');
            if (val && !addSizes.includes(val)) {
                addSizes.push(val);
                needsTableUpdate = true;
            }
            addSizeInput.value = '';
        }
        if (addHasColorsToggle.checked && addColorInput && addColorInput.value.trim() !== '') {
            const val = addColorInput.value.trim().replace(/,/g, '');
            if (val && !addColors.includes(val)) {
                addColors.push(val);
                needsTableUpdate = true;
            }
            addColorInput.value = '';
        }
        if (needsTableUpdate) {
            triggerAddTableUpdate();
        }

        const submitBtn = document.getElementById('submit-add-btn');
        const originalText = submitBtn.textContent;
        submitBtn.textContent = 'Αποθήκευση...';
        submitBtn.disabled = true;

        try {
            const inputs = Array.from(document.querySelectorAll('.add-image-input'));
            const images = inputs.map(input => input.value.trim()).filter(val => val !== '');
            const primaryImage = images[0] || '';
            const hoverImage = images[1] || primaryImage;
            
            const hasSizes = addHasSizesToggle.checked;
            const hasColors = addHasColorsToggle.checked;
            const finalSizes = hasSizes ? [...addSizes] : [];
            const finalColors = hasColors ? [...addColors] : [];
            const productType = (finalSizes.length > 0 || finalColors.length > 0) ? 'variable' : 'simple';
            const basePrice = parseFloat(document.getElementById('add-price').value);
            const variationRows = productType === 'variable'
                ? document.querySelectorAll('#add-variations-table-container .variation-row')
                : [];
            if (productType === 'variable' && (addVariationLimitExceeded || variationRows.length === 0)) {
                // Writing a "variable" parent with no children produces a
                // product the storefront can render but nobody can buy.
                alert('Δεν είναι δυνατή η αποθήκευση: ο πίνακας παραλλαγών είναι κενός ή ξεπερνά το όριο των '
                    + MAX_VARIATIONS + ' παραλλαγών.');
                return;
            }

            const invalidImage = images.find(url => !isSafeMediaUrl(url));
            if (invalidImage) {
                alert('Μη έγκυρο URL εικόνας. Επιτρέπονται μόνο διευθύνσεις http:// ή https://.');
                return;
            }

            const parentPrice = productType === 'variable'
                ? getMinimumVariationPrice(variationRows, basePrice)
                : basePrice;

            // Every sale price is validated against its own regular price
            // before a single document is written.
            const salePricing = collectSalePricing('add', productType, variationRows, basePrice, parentPrice);
            if (salePricing.error) {
                alert(salePricing.error);
                return;
            }

            const optionalFields = await collectOptionalFields('add');

            // 1. Prepare Parent Product Data
            const parentProduct = {
                type: productType,
                parent_id: null,
                ...optionalFields,
                title: document.getElementById('add-title').value.trim(),
                sku: document.getElementById('add-sku').value.trim(),
                price: parentPrice,
                stock: productType === 'simple' ? (parseInt(document.getElementById('add-stock').value) || 0) : 0,
                categories: document.getElementById('add-category').value,
                estimated_dispatch: document.getElementById('add-dispatch').value,
                status: document.getElementById('add-status').value,
                isFeatured: addIsFeaturedToggle ? addIsFeaturedToggle.checked : false,
                description: getQuillHTML(quillAdd),
                materials: document.getElementById('add-materials').value.trim(),
                materialsLabel: document.getElementById('add-materials-label').value.trim() || 'Κατασκευή',
                care: document.getElementById('add-care').value.trim(),
                careLabel: document.getElementById('add-care-label').value.trim() || 'Care',
                dimensions: document.getElementById('add-dimensions').value.trim(),
                dimensionsLabel: document.getElementById('add-dimensions-label').value.trim() || 'Dimensions',
                image: primaryImage,
                hoverImage: hoverImage,
                images: images
            };

            if (productType === 'simple' && salePricing.parentSalePrice !== null) {
                parentProduct.salePrice = salePricing.parentSalePrice;
            }
            if (productType === 'variable' && salePricing.listing) {
                parentProduct.listingPrice = salePricing.listing.price;
                if (salePricing.listing.compareAtPrice !== null) {
                    parentProduct.listingCompareAtPrice = salePricing.listing.compareAtPrice;
                }
            }

            if (productType === 'variable') {
                parentProduct.variation_attributes = [];
                if (finalColors.length > 0) {
                    parentProduct.variation_attributes.push({
                        attribute_id: "attr_color",
                        name: "Color",
                        terms: finalColors.map(c => ({ id: `term_color_${c.toLowerCase().replace(/\s+/g, '')}`, value: c }))
                    });
                }
                if (finalSizes.length > 0) {
                    parentProduct.variation_attributes.push({
                        attribute_id: "attr_size",
                        name: "Size",
                        terms: finalSizes.map(s => ({ id: `term_size_${s.toLowerCase().replace(/\s+/g, '')}`, value: s }))
                    });
                }
            }

            // 2. Initialize category-validated transaction
            const batch = taxonomyBatch(parentProduct);
            
            // 3. Create Parent Document Reference
            const parentDocRef = doc(collection(db, "products"));
            batch.set(parentDocRef, { ...parentProduct, createdAt: serverTimestamp() });

            // 4. Harvest Table Rows & Create Child Variations
            if (productType === 'variable') {
                variationRows.forEach((row, rowIndex) => {
                    const colorVal = row.getAttribute('data-color');
                    const sizeVal = row.getAttribute('data-size');
                    const varSku = row.querySelector('.var-sku').value.trim();
                    const varPrice = parseVariationPrice(row) ?? parentProduct.price;
                    const varSale = salePricing.rowSales[rowIndex] ?? null;
                    const varStock = parseInt(row.querySelector('.var-stock').value) || 0;
                    const varImage = row.querySelector('.var-image').value.trim();

                    const colorTermId = colorVal ? `term_color_${colorVal.toLowerCase().replace(/\s+/g, '')}` : null;
                    const sizeTermId = sizeVal ? `term_size_${sizeVal.toLowerCase().replace(/\s+/g, '')}` : null;

                    const attributesMap = {};
                    const attributeTerms = [];
                    let varTitleSuffix = [];

                    if (colorVal) {
                        attributesMap['attr_color'] = colorTermId;
                        attributeTerms.push(colorTermId);
                        varTitleSuffix.push(colorVal);
                    }
                    if (sizeVal) {
                        attributesMap['attr_size'] = sizeTermId;
                        attributeTerms.push(sizeTermId);
                        varTitleSuffix.push(sizeVal);
                    }

                    const childProduct = {
                        type: 'variation',
                        parent_id: parentDocRef.id,
                        title: `${parentProduct.title} - ${varTitleSuffix.join(' / ')}`,
                        sku: varSku,
                        price: varPrice,
                        stock: varStock,
                        status: parentProduct.status,
                        image: varImage || primaryImage,
                        attribute_terms: attributeTerms,
                        attributes_map: attributesMap,
                        createdAt: serverTimestamp()
                    };
                    if (varSale !== null) childProduct.salePrice = varSale;

                    const childDocRef = doc(collection(db, "products"));
                    batch.set(childDocRef, childProduct);
                });
            }

            // 5. Commit Batch to Firestore
            await batch.commit();
            await logAdminAction('CREATE', 'products', `Δημιουργία προϊόντος: ${parentProduct.title} (Τύπος: ${productType})`, { productId: parentDocRef.id, sku: parentProduct.sku });

            resetAddProductUI();
            // Only the new product and its variations (was: the whole catalogue).
            await refreshProductFamily(parentDocRef.id);

        } catch (error) {
            console.error("Error adding product with variations:", error);
            alert(error.message || "Σφάλμα κατά την αποθήκευση του προϊόντος και των παραλλαγών του.");
        } finally {
            submitBtn.textContent = originalText;
            submitBtn.disabled = false;
        }
    });

    // ==========================================
    // BULK EXPORT (CSV) LOGIC
    // ==========================================
    if (exportProductsCsvBtn) {
        exportProductsCsvBtn.addEventListener('click', async () => {
            if (productsList.length === 0) {
                alert("Δεν υπάρχουν προϊόντα για εξαγωγή.");
                return;
            }

            const originalText = exportProductsCsvBtn.innerHTML;
            exportProductsCsvBtn.innerHTML = 'Εξαγωγή...';
            exportProductsCsvBtn.disabled = true;

            try {
                // `salePrice` sits right after `price`: the FINAL discounted price
                // (empty when the product has no valid discount). The importer
                // reads it back, so a discounted catalogue survives a round trip.
                const headers = [
                    "type", "parent_id", "title", "price", "salePrice", "stock", "categories", "sku", 
                    "description", "image", "hoverImage", "status", "isFeatured", 
                    "estimated_dispatch", "dimensions", "dimensionsLabel", "materials", "materialsLabel", "care", "careLabel", "sizes", "colors", "subcategoryId", "subcategory", "brand", "id", "variation_attributes", "attributes_map"
                ];

                const escapeCsvValue = encodeCsvCell;

                let csvContent = "\uFEFF" + headers.join(",") + "\n";

                productsList.forEach(product => {
                    const row = [
                        product.type || "simple",
                        product.parent_id || "",
                        product.title || "",
                        product.price || 0,
                        getSaleCents(product) !== null ? product.salePrice : "",
                        product.stock || 0,
                        product.type === 'variation' ? "" : product.categories || "",
                        product.sku || "",
                        product.description || product.desc || "",
                        product.image || (product.images && product.images[0] ? product.images[0] : ""),
                        product.hoverImage || (product.images && product.images[1] ? product.images[1] : ""),
                        product.status || "active",
                        product.isFeatured === true ? "true" : "false",
                        product.estimated_dispatch || "2-3 estimated days",
                        product.dimensions || "",
                        product.dimensionsLabel || "Dimensions",
                        product.materials || "",
                        product.materialsLabel || "Κατασκευή",
                        product.care || product.customCare || "",
                        product.careLabel || "Care",
                        product.sizes || [],
                        product.colors || [],
                        product.type === 'variation' ? '' : product.subcategoryId || '',
                        product.type === 'variation' ? '' : findSubcategory(productCategories, product.categories, product.subcategoryId)?.name || '',
                        product.type === 'variation' ? '' : product.brand || '',
                        product.id,
                        product.type === 'variable' && product.variation_attributes ? JSON.stringify(product.variation_attributes) : '',
                        product.type === 'variation' && product.attributes_map ? JSON.stringify(product.attributes_map) : ''
                    ];
                    csvContent += row.map(escapeCsvValue).join(",") + "\n";
                });

                const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement("a");
                link.setAttribute("href", url);
                
                const date = new Date();
                const dateString = date.toISOString().split('T')[0];
                link.setAttribute("download", `products_export_${dateString}.csv`);
                
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                URL.revokeObjectURL(url);

                await logAdminAction('EXPORT', 'products', 'Εξαγωγή προϊόντων σε CSV', { count: productsList.length });

            } catch (error) {
                console.error("Export CSV Error:", error);
                alert("Σφάλμα κατά την εξαγωγή του CSV.");
            } finally {
                exportProductsCsvBtn.innerHTML = originalText;
                exportProductsCsvBtn.disabled = false;
            }
        });
    }

    // ==========================================
    // BULK IMPORT (CSV) LOGIC
    // ==========================================
    openBulkImportBtn.addEventListener('click', () => {
        if (typeof Papa === 'undefined') {
            alert('Η βιβλιοθήκη PapaParse δεν φορτώθηκε. Ελέγξτε τη σύνδεσή σας.');
            return;
        }
        bulkImportModal.classList.remove('hidden');
    });

    function resetBulkImportModal() {
        bulkImportModal.classList.add('hidden');
        csvFileInput.value = '';
        parsedCsvData = [];
        csvPreviewContainer.classList.add('hidden');
        csvProgressContainer.classList.add('hidden');
        csvErrors.classList.add('hidden');
        csvErrors.innerHTML = '';
        csvPreviewTbody.innerHTML = '';
        startBulkImportBtn.disabled = true;
        csvProgressBar.style.width = '0%';
        csvProgressPercent.textContent = '0%';
        csvProgressText.textContent = 'Εισαγωγή 0 / 0...';
    }

    closeBulkImportBtn.addEventListener('click', resetBulkImportModal);
    bulkImportBackdrop.addEventListener('click', resetBulkImportModal);

    downloadCsvTemplateBtn.addEventListener('click', () => {
        // `salePrice` is OPTIONAL: the final discounted price in EUR, strictly
        // below `price` (leave empty for no discount). It is not allowed on
        // rows that have sizes/colors — variations carry their own.
        const headers = ["type", "parent_id", "name", "price", "salePrice", "stock", "category", "sku", "description", "imageUrl", "isFeatured", "materialsLabel", "careLabel", "dimensionsLabel", "sizes", "colors", "subcategoryId", "subcategory", "brand"];
        const sampleRows = [
            ["simple", "", "Minimalist Oak Table", "1250.50", "", "15", productCategories[0]?.name || "", "TBL-001", "Solid oak dining table.", "https://example.com/table.jpg", "false", "Κατασκευή", "Care", "Dimensions", "", ""],
            ["simple", "", "Minimalist Oak Chair", "123", "104", "20", productCategories[0]?.name || "", "CHR-001", "Solid oak chair (discounted from 123 to 104).", "https://example.com/chair.jpg", "false", "Κατασκευή", "Care", "Dimensions", "", ""]
        ];
        
        let csvContent = "\uFEFF" + headers.join(",") + "\n"
            + sampleRows.map(sampleRow => sampleRow.concat(["", "", ""]).map(encodeCsvCell).join(",")).join("\n");
        
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.setAttribute("href", url);
        link.setAttribute("download", "product_import_template.csv");
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    });

    // Drag and Drop for CSV
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        csvDropzone.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    ['dragenter', 'dragover'].forEach(eventName => {
        csvDropzone.addEventListener(eventName, () => {
            csvDropzone.classList.add('border-neutral-500', 'bg-neutral-100');
        }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        csvDropzone.addEventListener(eventName, () => {
            csvDropzone.classList.remove('border-neutral-500', 'bg-neutral-100');
        }, false);
    });

    csvDropzone.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const files = dt.files;
        if (files && files.length > 0) {
            handleCsvFile(files[0]);
        }
    });

    csvDropzone.addEventListener('click', () => {
        csvFileInput.click();
    });

    csvFileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files.length > 0) {
            handleCsvFile(e.target.files[0]);
        }
    });

    // Import ceilings. Firestore's hard limit is 500 writes per batch; the
    // chunk size below sits under it with room for the timestamp fields. The
    // row ceiling is about the browser: 20k rows is ~50 sequential commits, a
    // frozen tab, and a half-written catalogue if the operator closes it.
    const CSV_CHUNK_SIZE = 400;
    const CSV_MAX_ROWS = 2000;
    const CSV_MAX_FILE_BYTES = 10 * 1024 * 1024;
    const CSV_ALLOWED_TYPES = new Set(['simple', 'variable', 'variation']);

    function handleCsvFile(file) {
        if (!file.name.toLowerCase().endsWith('.csv')) {
            alert('Παρακαλώ επιλέξτε ένα αρχείο .csv');
            return;
        }

        if (file.size > CSV_MAX_FILE_BYTES) {
            alert('Το αρχείο CSV είναι πολύ μεγάλο (όριο 10MB).');
            return;
        }

        Papa.parse(file, {
            header: true,
            skipEmptyLines: true,
            complete: function(results) {
                processCsvData(results.data);
            },
            error: function(err) {
                alert('Σφάλμα κατά την ανάγνωση του αρχείου: ' + err.message);
            }
        });
    }

    async function processCsvData(data) {
        try {
            const snap = await getDoc(doc(db, 'settings', 'categories'));
            if (snap.metadata.fromCache) throw new Error('Χρειάζεται σύνδεση για εισαγωγή.');
            productCategories = categoryTree(snap.data()?.list);
        } catch (error) { alert(error.message); return; }
        let errors = [];
        let validRows = [];
        const seenSkus = new Set();

        const rows = Array.isArray(data) ? data : [];
        if (rows.length > CSV_MAX_ROWS) {
            errors.push(`Το αρχείο έχει ${rows.length} γραμμές. Θα εισαχθούν μόνο οι πρώτες ${CSV_MAX_ROWS}.`);
        }

        rows.slice(0, CSV_MAX_ROWS).forEach((rawRow, index) => {
            const row = Object.fromEntries(Object.entries(rawRow).map(([key, value]) => [key, decodeCsvText(value)]));
            const lineNumber = index + 2;
            // The export writes title/categories/image while the template uses
            // name/category/imageUrl: both spellings are accepted so an
            // exported file can be re-imported.
            const name = (row.name || row.title || '').trim().slice(0, 200);
            let priceStr = (row.price || '').trim().replace(',', '.');
            const price = parseFloat(priceStr);
            let stockStr = (row.stock || '').trim();
            const stock = parseInt(stockStr, 10);
            
            const type = (row.type || 'simple').trim().toLowerCase();
            const parent_id = (row.parent_id || '').trim();
            const sku = (row.sku || '').trim().slice(0, 100);
            const imageUrl = (row.imageUrl || row.image || '').trim();

            const sizes = row.sizes ? row.sizes.split(';').map(s => s.trim()).filter(Boolean).slice(0, 50) : [];
            const colors = row.colors ? row.colors.split(';').map(c => c.trim()).filter(Boolean).slice(0, 50) : [];
            // Explicit exported types are authoritative; simple facet tags do not create a variable family.
            const finalType = !String(row.type || '').trim() && (sizes.length > 0 || colors.length > 0) ? 'variable' : type;

            // Optional sale price: the FINAL discounted price, strictly below
            // this row's own price. Never silently dropped or rounded: a bad
            // value is reported and the row is not imported.
            const salePriceRaw = String(row.salePrice ?? row.sale_price ?? '').trim();
            let salePrice = null;
            let saleError = '';
            if (salePriceRaw) {
                const parsedSale = parseEuroInput(salePriceRaw);
                if (!parsedSale.ok) {
                    saleError = `Γραμμή ${lineNumber}: ${SALE_PROBLEMS[parsedSale.reason] || SALE_PROBLEMS.format} (salePrice)`;
                } else if (finalType === 'variable') {
                    saleError = `Γραμμή ${lineNumber}: Η τιμή έκπτωσης (salePrice) δεν επιτρέπεται σε προϊόν με παραλλαγές — ορίστε την στις γραμμές των παραλλαγών.`;
                } else if (!Number.isFinite(price) || parsedSale.cents >= toCents(price)) {
                    saleError = `Γραμμή ${lineNumber}: Η τιμή έκπτωσης (salePrice) πρέπει να είναι μικρότερη από την τιμή (price).`;
                } else {
                    salePrice = parsedSale.value;
                }
            }
            if (saleError) errors.push(saleError);

            if (!name) errors.push(`Γραμμή ${lineNumber}: Λείπει το όνομα (name).`);
            if (isNaN(price) || price < 0) errors.push(`Γραμμή ${lineNumber}: Μη έγκυρη τιμή (price).`);
            if (Number.isFinite(price) && price > 1000000) errors.push(`Γραμμή ${lineNumber}: Η τιμή ξεπερνά το επιτρεπτό όριο.`);

            // The type column was written straight through. Anything at all —
            // an empty string, a typo, "admin" — became the product's type,
            // and rows typed as 'variation' with no parent_id became orphans:
            // invisible in this table (it filters variations out) but live in
            // every storefront query.
            if (!CSV_ALLOWED_TYPES.has(type)) {
                errors.push(`Γραμμή ${lineNumber}: Μη έγκυρος τύπος "${type}". Επιτρέπονται: simple, variable, variation.`);
            }
            if (type === 'variation' && !parent_id) {
                errors.push(`Γραμμή ${lineNumber}: Οι παραλλαγές (variation) απαιτούν parent_id.`);
            }
            if (imageUrl && !isSafeMediaUrl(imageUrl)) {
                errors.push(`Γραμμή ${lineNumber}: Μη έγκυρο URL εικόνας.`);
            }
            if (sku && seenSkus.has(sku.toLowerCase())) {
                errors.push(`Γραμμή ${lineNumber}: Διπλότυπο SKU "${sku}" μέσα στο αρχείο.`);
            }

            let optionalFields = {};
            let taxonomyError = '';
            let variationFields = {};
            try {
                optionalFields = importOptionalFields({ ...row, type }, productCategories);
                variationFields = importVariationFields(row, finalType);
            }
            catch (error) { taxonomyError = `Γραμμή ${lineNumber}: ${error.message}`; errors.push(taxonomyError); }
            const rowIsValid = name
                && !taxonomyError
                && !saleError
                && Number.isFinite(price) && price >= 0 && price <= 1000000
                && CSV_ALLOWED_TYPES.has(type)
                && !(type === 'variation' && !parent_id)
                && !(imageUrl && !isSafeMediaUrl(imageUrl))
                && !(sku && seenSkus.has(sku.toLowerCase()));

            if (rowIsValid) {
                if (sku) seenSkus.add(sku.toLowerCase());

                validRows.push({
                    ...(String(row.id || '').trim() ? { _sourceId: String(row.id).trim() } : {}),
                    type: finalType,
                    ...variationFields,
                    parent_id: type === 'variation' ? parent_id : null,
                    title: name,
                    price: price,
                    ...(salePrice !== null ? { salePrice } : {}),
                    stock: isNaN(stock) || stock < 0 ? 0 : stock,
                    ...(type === 'variation' ? {} : { categories: (row.category || row.categories || '').trim(), ...optionalFields }),
                    sku: sku,
                    description: sanitizeRichText((row.description || '').trim()),
                    image: imageUrl,
                    // The storefront reads hoverImage and images[]; leaving
                    // them undefined made every imported product render
                    // differently from a hand-created one.
                    hoverImage: imageUrl,
                    images: imageUrl ? [imageUrl] : [],
                    status: 'active',
                    isFeatured: (row.isFeatured || '').trim().toLowerCase() === 'true',
                    estimated_dispatch: '2-3 estimated days',
                    materialsLabel: (row.materialsLabel || '').trim() || 'Κατασκευή',
                    careLabel: (row.careLabel || '').trim() || 'Care',
                    dimensionsLabel: (row.dimensionsLabel || '').trim() || 'Dimensions',
                    sizes: sizes,
                    colors: colors,
                    tenantId: getCurrentUser() ? getCurrentUser().uid : null
                });
            }
        });

        parsedCsvData = validRows;
        
        csvPreviewContainer.classList.remove('hidden');
        csvRowsCount.textContent = `Έγκυρα Προϊόντα: ${validRows.length}`;

        if (errors.length > 0) {
            csvErrors.innerHTML = `<strong>Βρέθηκαν Σφάλματα:</strong><br><ul class="list-disc pl-5 mt-2">${errors.slice(0, 10).map(e => `<li>${escapeHTML(e)}</li>`).join('')}${errors.length > 10 ? `<li>...και άλλα ${errors.length - 10} σφάλματα.</li>` : ''}</ul>`;
            csvErrors.classList.remove('hidden');
        } else {
            csvErrors.classList.add('hidden');
        }

        csvPreviewTbody.innerHTML = validRows.slice(0, 5).map(row => `
            <tr class="border-b border-gray-100 last:border-0 hover:bg-neutral-50 transition-colors">
                <td class="p-2 truncate max-w-[150px]">${escapeHTML(row.title)}</td>
                <td class="p-2 text-neutral-500">${escapeHTML(row.sku || '-')}</td>
                <td class="p-2">${Number.isFinite(row.salePrice)
                    ? `<span class="line-through text-neutral-400 mr-1">€${row.price.toLocaleString('el-GR')}</span>€${row.salePrice.toLocaleString('el-GR')}`
                    : `€${row.price.toLocaleString('el-GR')}`}</td>
                <td class="p-2">${row.stock}</td>
                <td class="p-2 text-neutral-500">${escapeHTML(row.categories || '-')}</td>
            </tr>
        `).join('');

        if (validRows.length > 5) {
            csvPreviewTbody.innerHTML += `<tr><td colspan="5" class="p-2 text-center text-neutral-400 italic">...και άλλα ${validRows.length - 5} προϊόντα.</td></tr>`;
        }

        startBulkImportBtn.disabled = validRows.length === 0;
    }

    startBulkImportBtn.addEventListener('click', async () => {
        if (parsedCsvData.length === 0) return;

        if (!getCurrentUser()) {
            alert('Η συνεδρία σας έληξε. Συνδεθείτε ξανά.');
            return;
        }

        // Rows that failed validation are dropped silently by the preview.
        // Importing a 600-row file and getting 300 products, with no moment
        // where anyone had to acknowledge that, is how a catalogue quietly
        // ends up half-loaded.
        if (!csvErrors.classList.contains('hidden')) {
            if (!confirm(`Το αρχείο περιέχει σφάλματα. Θα εισαχθούν μόνο οι ${parsedCsvData.length} έγκυρες γραμμές. Συνέχεια;`)) {
                return;
            }
        }

        startBulkImportBtn.disabled = true;
        closeBulkImportBtn.disabled = true;
        csvProgressContainer.classList.remove('hidden');
        csvProgressContainer.classList.add('flex');

        let processed = 0;
        const total = parsedCsvData.length;

        try {
            const categorySnap = await getDoc(doc(db, 'settings', 'categories'));
            if (categorySnap.metadata.fromCache) throw new Error('Χρειάζεται σύνδεση για εισαγωγή.');
            const importTree = categoryTree(categorySnap.data()?.list);
            parsedCsvData.forEach(product => {
                if (product.type !== 'variation') importOptionalFields(product, importTree);
            });
            const importRefs = parsedCsvData.map(() => doc(collection(db, 'products')));
            const sourceParents = new Map();
            const sourceIds = new Set();
            parsedCsvData.forEach((product, index) => {
                if (!product._sourceId) return;
                if (sourceIds.has(product._sourceId)) throw new Error('Διπλότυπο id στο CSV.');
                sourceIds.add(product._sourceId);
                if (product.type === 'variable') sourceParents.set(product._sourceId, importRefs[index].id);
            });
            const externalParents = new Set(parsedCsvData.filter(p => p.type === 'variation' && !sourceParents.has(p.parent_id)).map(p => p.parent_id));
            for (const parentId of externalParents) {
                if (sourceIds.has(parentId)) throw new Error('Ο γονέας παραλλαγής στο CSV δεν είναι variable.');
                const parent = await getDoc(doc(db, 'products', parentId));
                if (parent.metadata.fromCache || !parent.exists() || parent.data().type !== 'variable') {
                    throw new Error('Μη έγκυρος γονέας παραλλαγής: ' + parentId);
                }
            }
            for (let i = 0; i < total; i += CSV_CHUNK_SIZE) {
                const chunk = parsedCsvData.slice(i, i + CSV_CHUNK_SIZE);
                const batch = writeBatch(db);
                
                chunk.forEach((product, index) => {
                    const { _sourceId, ...storedProduct } = product;
                    if (storedProduct.type === 'variation' && sourceParents.has(storedProduct.parent_id)) {
                        storedProduct.parent_id = sourceParents.get(storedProduct.parent_id);
                    }
                    batch.set(importRefs[i + index], {
                        ...storedProduct,
                        createdAt: serverTimestamp(),
                        updatedAt: serverTimestamp()
                    });
                });

                await batch.commit();
                
                processed += chunk.length;
                const percent = Math.round((processed / total) * 100);
                csvProgressBar.style.width = `${percent}%`;
                csvProgressPercent.textContent = `${percent}%`;
                csvProgressText.textContent = `Εισαγωγή ${processed} / ${total}...`;
            }

            await logAdminAction('IMPORT', 'products', 'Μαζική εισαγωγή προϊόντων μέσω CSV', { count: total });
            alert(`Η μαζική εισαγωγή ολοκληρώθηκε! Προστέθηκαν ${total} προϊόντα.`);
            resetBulkImportModal();
            await fetchProducts();

        } catch (error) {
            // A batch is atomic, but the loop is not: everything committed
            // before the failure is already in the catalogue. Say exactly how
            // much landed, and record it in the audit trail, so the operator
            // can trim the CSV and resume instead of re-importing duplicates.
            console.error("Bulk Import Error:", error);
            try {
                await logAdminAction('IMPORT', 'products',
                    'Μερική αποτυχία μαζικής εισαγωγής CSV',
                    { imported: processed, total, error: String(error && error.message || error) });
            } catch (logError) {
                console.warn('[admin-products] Could not log the partial import:', logError);
            }
            alert(`Σφάλμα κατά την εισαγωγή. Εισήχθησαν ${processed} από ${total} προϊόντα πριν τη διακοπή. `
                + `${error.message || ''} Αφαιρέστε τις πρώτες ${processed} γραμμές από το CSV πριν δοκιμάσετε ξανά.`);
            await fetchProducts();
        } finally {
            closeBulkImportBtn.disabled = false;
            // Previously left disabled forever on failure, forcing a reload
            // before the operator could retry.
            startBulkImportBtn.disabled = parsedCsvData.length === 0;
        }
    });

    // ==========================================
    // 5. EVENT DELEGATION (Edit/Delete Products)
    // ==========================================
    productsTableBody.addEventListener('click', async (e) => {
        const productId = e.target.getAttribute('data-id');
        
        if (e.target.classList.contains('edit-product-btn')) {
            openEditModal(productId);
        } else if (e.target.classList.contains('delete-product-btn')) {
            if (confirm("Είστε σίγουροι ότι θέλετε να διαγράψετε αυτό το προϊόν; Η ενέργεια δεν μπορεί να αναιρεθεί.")) {
                try {
                    const currentUser = getCurrentUser();
                    if (!currentUser) {
                        alert('Η συνεδρία σας έληξε. Συνδεθείτε ξανά.');
                        return;
                    }

                    const productToDel = productsList.find(p => p.id === productId);

                    // ORDER MATTERS. The previous version destroyed the R2
                    // objects first and only then attempted the Firestore
                    // deletes: any failure in the (multi-batch, cascading)
                    // delete left a live catalogue entry pointing at images
                    // that no longer exist — a broken product page, with no
                    // way back. Firestore is now the first and only
                    // irreversible step; bucket cleanup is best-effort
                    // afterwards, and the worst case is an orphaned object
                    // that the storage meter re-counts on its next ground-truth
                    // read.
                    const childVariations = productToDel && productToDel.type === 'variable'
                        ? (await getDocs(query(
                            collection(db, "products"),
                            where("parent_id", "==", productId),
                            where("type", "==", "variation")
                          ))).docs
                        : [];

                    // Cascade delete for parent and child variations, chunked
                    // under the hard 500-operation batch limit.
                    const batchArray = [writeBatch(db)];
                    let operationCount = 0;
                    let batchIndex = 0;

                    batchArray[batchIndex].delete(doc(db, "products", productId));
                    operationCount++;

                    childVariations.forEach(childDoc => {
                        if (operationCount >= 499) {
                            batchArray.push(writeBatch(db));
                            batchIndex++;
                            operationCount = 0;
                        }
                        batchArray[batchIndex].delete(childDoc.ref);
                        operationCount++;
                    });

                    for (const b of batchArray) {
                        await b.commit();
                    }

                    await logAdminAction('DELETE', 'products', `Διαγραφή προϊόντος: ${productToDel?.title || productId}`, { productId });

                    // Best-effort bucket cleanup. Variation images were
                    // previously leaked entirely — only the parent's URLs were
                    // collected, so every per-variation image stayed in R2
                    // consuming quota forever.
                    if (productToDel) {
                        const rawUrls = [
                            productToDel.image,
                            productToDel.hoverImage,
                            ...(productToDel.images || []),
                            ...childVariations.map(childDoc => childDoc.data().image)
                        ];
                        const imageUrls = [...new Set(rawUrls.filter(url => typeof url === 'string' && url.trim() !== ''))];

                        try {
                            const idToken = await currentUser.getIdToken();

                            const freedResults = await Promise.all(imageUrls.map(async (url) => {
                                try {
                                    const res = await fetch('/api/r2?action=delete-file', {
                                        method: 'POST',
                                        headers: {
                                            'Content-Type': 'application/json',
                                            'Authorization': `Bearer ${idToken}`
                                        },
                                        body: JSON.stringify({ url })
                                    });
                                    if (!res.ok) return 0;
                                    const resData = await res.json();
                                    return Number(resData.freedBytes) || 0;
                                } catch (imgDelErr) {
                                    console.error("Error deleting product image from R2:", imgDelErr);
                                    return 0;
                                }
                            }));

                            const totalFreed = freedResults.reduce((total, bytes) => total + bytes, 0);
                            if (totalFreed > 0) {
                                adjustStorageUsage(-totalFreed);
                            }
                        } catch (cleanupError) {
                            console.warn('[admin-products] Bucket cleanup after delete failed:', cleanupError);
                        }
                    }

                    // The deleted family is known exactly: drop it locally (0
                    // reads, was the whole catalogue) and from the snapshot.
                    productsList = productsList.filter(item => item.id !== productId && item.parent_id !== productId);
                    renderProductsTable();
                    await patchCatalogSnapshot([productId]);
                    updateStorageUIOnly();
                } catch (error) {
                    console.error("Error deleting product:", error);
                    alert("Σφάλμα διαγραφής.");
                }
            }
        }
    });

    function openEditModal(id) {
        const product = productsList.find(p => p.id === id);
        if (!product) return;

        document.getElementById('edit-id').value = product.id;
        document.getElementById('edit-title').value = product.title;
        document.getElementById('edit-sku').value = product.sku || '';
        document.getElementById('edit-price').value = product.price || 0;
        // A simple product shows its stored sale (only if it is still valid
        // against the regular price); a variable one takes sales per variation.
        discountVariationMode.edit = product.type === 'variable';
        const storedSaleCents = product.type === 'variable' ? null : getSaleCents(product);
        setDiscountState('edit', storedSaleCents === null ? null : storedSaleCents / 100);
        const editStockInput = document.getElementById('edit-stock');
        editStockInput.value = product.stock || 0;
        // The value the admin was SHOWN. The save compares it with the live
        // stock so concurrent sales are never overwritten.
        editStockInput.dataset.originalStock = String(Number(product.stock) || 0);
        
        const categorySelect = document.getElementById('edit-category');
        if (![...categorySelect.options].some(o => o.value === product.categories) && product.categories) {
            categorySelect.insertAdjacentHTML('beforeend', `<option value="${escapeHTML(product.categories)}">${escapeHTML(product.categories)}</option>`);
        }
        categorySelect.value = product.categories || "";
        document.getElementById('edit-brand').value = product.brand || '';
        renderSubcategoryOptions('edit', product.subcategoryId || '');
        
        const dispatchSelect = document.getElementById('edit-dispatch');
        if ([...dispatchSelect.options].some(o => o.value === product.estimated_dispatch)) {
            dispatchSelect.value = product.estimated_dispatch;
        } else {
            dispatchSelect.value = "2-3 estimated days";
        }

        const statusSelect = document.getElementById('edit-status');
        if ([...statusSelect.options].some(o => o.value === product.status)) {
            statusSelect.value = product.status;
        } else {
            statusSelect.value = "active";
        }

        if (editIsFeaturedToggle) {
            editIsFeaturedToggle.checked = product.isFeatured === true;
        }

        // Load stored HTML into Quill. Products created before this upgrade
        // hold plain text, which pastes in as a single paragraph — no data
        // migration is required. setContents([]) first so the previous
        // product's description is fully replaced rather than appended to.
        if (quillEdit) {
            quillEdit.setContents([]);
            // CRITICAL: sanitize on the way IN as well as on the way out.
            // dangerouslyPasteHTML assigns the string into a live DOM subtree,
            // so a stored <img src=x onerror=...> — from a document written
            // before this sanitizer existed, from a direct Firestore write, or
            // from any future import path — executes in the admin origin the
            // moment the edit modal opens, with a valid admin session attached.
            // Sanitizing here means the panel can never be attacked by its own
            // database.
            quillEdit.clipboard.dangerouslyPasteHTML(
                sanitizeRichText(product.description || product.desc || '')
            );
        }
        
        document.getElementById('edit-materials').value = product.materials || '';
        document.getElementById('edit-materials-label').value = product.materialsLabel || 'Κατασκευή';
        
        document.getElementById('edit-care').value = product.care || product.customCare || '';
        document.getElementById('edit-care-label').value = product.careLabel || 'Care';
        
        document.getElementById('edit-dimensions').value = product.dimensions || '';
        document.getElementById('edit-dimensions-label').value = product.dimensionsLabel || 'Dimensions';

        // Load Variations correctly from variation_attributes
        editSizes = [];
        editColors = [];
        
        if (product.type === 'variable' && Array.isArray(product.variation_attributes)) {
            product.variation_attributes.forEach(attr => {
                if (attr.attribute_id === 'attr_size') {
                    editSizes = attr.terms.map(t => t.value);
                } else if (attr.attribute_id === 'attr_color') {
                    editColors = attr.terms.map(t => t.value);
                }
            });
        }

        if (editSizes.length > 0) {
            editHasSizesToggle.checked = true;
            editSizesContainer.classList.remove('hidden');
            editSizesContainer.classList.add('flex');
            renderChips(editSizes, editSizesChipArea, editSizeInput, removeEditSize);
        } else {
            editHasSizesToggle.checked = false;
            editSizesContainer.classList.add('hidden');
            editSizesContainer.classList.remove('flex');
            const sizeChips = editSizesChipArea.querySelectorAll('.chip');
            sizeChips.forEach(c => c.remove());
        }

        if (editColors.length > 0) {
            editHasColorsToggle.checked = true;
            editColorsContainer.classList.remove('hidden');
            editColorsContainer.classList.add('flex');
            renderChips(editColors, editColorsChipArea, editColorInput, removeEditColor);
        } else {
            editHasColorsToggle.checked = false;
            editColorsContainer.classList.add('hidden');
            editColorsContainer.classList.remove('flex');
            const colorChips = editColorsChipArea.querySelectorAll('.chip');
            colorChips.forEach(c => c.remove());
        }
        
        triggerEditTableUpdate();

        editImageInputsContainer.innerHTML = '';
        // Copy, never push into product.images: that array is the live object
        // held in productsList, so the old code mutated the cached document
        // and those synthesised entries were written back on the next save.
        let images = Array.isArray(product.images) ? [...product.images] : [];
        if (images.length === 0) {
            if (product.image) images.push(product.image);
            if (product.hoverImage && product.hoverImage !== product.image) images.push(product.hoverImage);
        }
        if (images.length === 0) images.push('');

        images.forEach((imgUrl, index) => {
            const inputHTML = `
                <div class="flex gap-2 items-center">
                    <input type="url" required class="edit-image-input w-full bg-transparent border-b border-gray-300 py-2 focus:outline-none focus:border-neutral-900" placeholder="${index === 0 ? 'URL Κύριας Εικόνας' : 'Επιπλέον URL Εικόνας'}" value="${escapeHTML(String(imgUrl || ''))}">
                    <button type="button" class="text-red-400 hover:text-red-700 font-bold text-xl remove-image-btn">&times;</button>
                </div>
            `;
            editImageInputsContainer.insertAdjacentHTML('beforeend', inputHTML);
        });
        refreshImageInputPlaceholders(editImageInputsContainer, '.edit-image-input');

        editModal.classList.remove('hidden');
    }

    function closeEditModal() {
        editModal.classList.add('hidden');
        editProductForm.reset();
        editImageInputsContainer.innerHTML = '';

        // See the note in resetAddProductUI(): form.reset() cannot clear Quill.
        clearQuill(quillEdit);
        
        if (editIsFeaturedToggle) editIsFeaturedToggle.checked = false;

        discountVariationMode.edit = false;
        setDiscountState('edit', null);

        // Reset Variations
        editHasSizesToggle.checked = false;
        editSizesContainer.classList.add('hidden');
        editSizesContainer.classList.remove('flex');
        editSizes = [];
        const sizeChips = editSizesChipArea.querySelectorAll('.chip');
        sizeChips.forEach(c => c.remove());

        editHasColorsToggle.checked = false;
        editColorsContainer.classList.add('hidden');
        editColorsContainer.classList.remove('flex');
        editColors = [];
        const colorChips = editColorsChipArea.querySelectorAll('.chip');
        colorChips.forEach(c => c.remove());
        
        document.getElementById('edit-variations-table-container').innerHTML = '';
        
        if (editProductImageFileInput) {
            editProductImageFileInput.value = '';
            editProductImageUrlHidden.value = '';
            editProductImageStatus.textContent = '';
            editProductImageStatus.className = 'font-sans text-xs text-neutral-500';
            clearProductMediaPreview(editProductImagePreviewWrap);
        }
    }

    async function handleEditCancel() {
        if (editProductImageUrlHidden && editProductImageUrlHidden.value && getCurrentUser()) {
            try {
                const idToken = await getCurrentUser().getIdToken();
                await fetch('/api/r2?action=delete-file', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${idToken}`
                    },
                    body: JSON.stringify({ url: editProductImageUrlHidden.value })
                });
            } catch (err) {
                console.warn('Failed to delete orphaned image on cancel:', err);
            }
            editProductImageUrlHidden.value = '';
        }
        closeEditModal();
    }

    closeModalBtn.addEventListener('click', handleEditCancel);
    editModalBackdrop.addEventListener('click', handleEditCancel);

    // Save Edited Product
    editProductForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        // Catch leftover inputs before processing arrays
        let needsTableUpdate = false;
        if (editHasSizesToggle.checked && editSizeInput && editSizeInput.value.trim() !== '') {
            const val = editSizeInput.value.trim().replace(/,/g, '');
            if (val && !editSizes.includes(val)) {
                editSizes.push(val);
                needsTableUpdate = true;
            }
            editSizeInput.value = '';
        }
        if (editHasColorsToggle.checked && editColorInput && editColorInput.value.trim() !== '') {
            const val = editColorInput.value.trim().replace(/,/g, '');
            if (val && !editColors.includes(val)) {
                editColors.push(val);
                needsTableUpdate = true;
            }
            editColorInput.value = '';
        }
        if (needsTableUpdate) {
            triggerEditTableUpdate();
        }

        const saveBtn = document.getElementById('save-modal-btn');
        const originalText = saveBtn.textContent;
        saveBtn.textContent = 'Αποθήκευση...';
        saveBtn.disabled = true;

        const id = document.getElementById('edit-id').value;
        try {
            const inputs = Array.from(document.querySelectorAll('.edit-image-input'));
            const images = inputs.map(input => input.value.trim()).filter(val => val !== '');
            const primaryImage = images[0] || '';
            const hoverImage = images[1] || primaryImage;

            const hasSizes = editHasSizesToggle.checked;
            const hasColors = editHasColorsToggle.checked;
            const finalSizes = hasSizes ? [...editSizes] : [];
            const finalColors = hasColors ? [...editColors] : [];
            const productType = (finalSizes.length > 0 || finalColors.length > 0) ? 'variable' : 'simple';
            const basePrice = parseFloat(document.getElementById('edit-price').value);
            const variationRows = productType === 'variable'
                ? document.querySelectorAll('#edit-variations-table-container .variation-row')
                : [];
            if (productType === 'variable' && (editVariationLimitExceeded || variationRows.length === 0)) {
                // CRITICAL: the obsolete-variation sweep further down deletes
                // every child that is not represented by a row in the table.
                // An empty table therefore means "delete them all" — which is
                // what happened whenever the Cartesian ceiling blanked the
                // table, or the table had not finished rendering. Refuse.
                alert('Δεν είναι δυνατή η αποθήκευση: ο πίνακας παραλλαγών είναι κενός ή ξεπερνά το όριο των '
                    + MAX_VARIATIONS + ' παραλλαγών. Οι υπάρχουσες παραλλαγές δεν τροποποιήθηκαν.');
                saveBtn.textContent = originalText;
                saveBtn.disabled = false;
                return;
            }

            const invalidImage = images.find(url => !isSafeMediaUrl(url));
            if (invalidImage) {
                alert('Μη έγκυρο URL εικόνας. Επιτρέπονται μόνο διευθύνσεις http:// ή https://.');
                saveBtn.textContent = originalText;
                saveBtn.disabled = false;
                return;
            }

            const parentPrice = productType === 'variable'
                ? getMinimumVariationPrice(variationRows, basePrice)
                : basePrice;

            // Every sale price is validated against its own regular price
            // before anything is written.
            const salePricing = collectSalePricing('edit', productType, variationRows, basePrice, parentPrice);
            if (salePricing.error) {
                alert(salePricing.error);
                saveBtn.textContent = originalText;
                saveBtn.disabled = false;
                return;
            }

            const optionalFields = await collectOptionalFields('edit', productsList.find(p => p.id === id));
            const updateData = {
                brand: optionalFields.brand || deleteField(),
                subcategoryId: optionalFields.subcategoryId || deleteField(),
                type: productType,
                title: document.getElementById('edit-title').value.trim(),
                sku: document.getElementById('edit-sku').value.trim(),
                price: parentPrice,
                // `stock` is deliberately NOT set here. It is added below, after
                // the live stock is re-read, only when the admin changed it.
                categories: document.getElementById('edit-category').value,
                estimated_dispatch: document.getElementById('edit-dispatch').value,
                status: document.getElementById('edit-status').value,
                isFeatured: editIsFeaturedToggle ? editIsFeaturedToggle.checked : false,
                description: getQuillHTML(quillEdit),
                materials: document.getElementById('edit-materials').value.trim(),
                materialsLabel: document.getElementById('edit-materials-label').value.trim() || 'Κατασκευή',
                care: document.getElementById('edit-care').value.trim(),
                careLabel: document.getElementById('edit-care-label').value.trim() || 'Care',
                dimensions: document.getElementById('edit-dimensions').value.trim(),
                dimensionsLabel: document.getElementById('edit-dimensions-label').value.trim() || 'Dimensions',
                image: primaryImage,
                hoverImage: hoverImage,
                images: images
            };

            // Sale fields: written when set, DELETED when not, so removing a
            // discount leaves no stale value behind. `createdAt` is never part
            // of an edit, so an edited product keeps its original creation time.
            if (productType === 'variable') {
                updateData.salePrice = deleteField();
                updateData.listingPrice = salePricing.listing ? salePricing.listing.price : deleteField();
                updateData.listingCompareAtPrice = salePricing.listing && salePricing.listing.compareAtPrice !== null
                    ? salePricing.listing.compareAtPrice
                    : deleteField();
            } else {
                updateData.salePrice = salePricing.parentSalePrice !== null
                    ? salePricing.parentSalePrice
                    : deleteField();
                updateData.listingPrice = deleteField();
                updateData.listingCompareAtPrice = deleteField();
            }

            if (productType === 'variable') {
                updateData.variation_attributes = [];
                if (finalColors.length > 0) {
                    updateData.variation_attributes.push({
                        attribute_id: "attr_color",
                        name: "Color",
                        terms: finalColors.map(c => ({ id: `term_color_${c.toLowerCase().replace(/\s+/g, '')}`, value: c }))
                    });
                }
                if (finalSizes.length > 0) {
                    updateData.variation_attributes.push({
                        attribute_id: "attr_size",
                        name: "Size",
                        terms: finalSizes.map(s => ({ id: `term_size_${s.toLowerCase().replace(/\s+/g, '')}`, value: s }))
                    });
                }
            } else {
                updateData.variation_attributes = null;
            }

            // Fetch existing variations to update/delete them instead of blindly creating new ones.
            // The parent document is re-read here too: both are the LIVE stock
            // values the stock-concurrency check below compares against.
            const existingVarsQuery = query(collection(db, "products"), where("parent_id", "==", id), where("type", "==", "variation"));
            const [existingVarsSnap, liveParentSnap] = await Promise.all([
                getDocs(existingVarsQuery),
                getDoc(doc(db, "products", id))
            ]);
            const existingVariations = {};
            const liveVariationStock = {};

            existingVarsSnap.forEach(d => {
                const data = d.data();
                const colorId = data.attributes_map?.attr_color || 'none';
                const sizeId = data.attributes_map?.attr_size || 'none';
                existingVariations[`${colorId}_${sizeId}`] = d.id;
                liveVariationStock[d.id] = Number(data.stock) || 0;
            });

            // ------------------------------------------------------------------
            // STOCK CONCURRENCY
            //
            // Orders decrement stock server-side (COD transaction in
            // create-payment.js, Viva webhook) while this modal is open. Writing
            // the form's number back unconditionally resurrected units that were
            // already sold: open with 10, two orders take it to 6, save a title
            // typo -> stock is 10 again and 4 units get sold twice.
            //
            //   - A stock field the admin did NOT change is never written, so
            //     concurrent sales are preserved.
            //   - A stock field the admin DID change is written only if the live
            //     value still equals what the admin was shown. Otherwise the save
            //     is refused and the admin re-opens the product to see reality.
            // ------------------------------------------------------------------
            const staleStockLabels = [];

            if (productType === 'simple') {
                const stockInput = document.getElementById('edit-stock');
                const requestedStock = parseInt(stockInput.value, 10) || 0;
                const originalStock = Number(stockInput.dataset.originalStock);
                const liveStock = Number(liveParentSnap.exists() ? liveParentSnap.data()?.stock : 0) || 0;
                const adminChangedStock = !Number.isFinite(originalStock) || requestedStock !== originalStock;

                if (adminChangedStock) {
                    if (Number.isFinite(originalStock) && liveStock !== originalStock) {
                        staleStockLabels.push(`${updateData.title} (τρέχον απόθεμα: ${liveStock})`);
                    } else {
                        updateData.stock = requestedStock;
                    }
                }
            } else {
                // A variable parent is never purchasable; its stock stays 0.
                updateData.stock = 0;
            }

            const batch = taxonomyBatch(updateData, productsList.find(p => p.id === id));
            const productRef = doc(db, "products", id);
            batch.update(productRef, updateData);

            if (productType === 'variable') {
                variationRows.forEach((row, rowIndex) => {
                    const colorVal = row.getAttribute('data-color');
                    const sizeVal = row.getAttribute('data-size');
                    const varSku = row.querySelector('.var-sku').value.trim();
                    const varPrice = parseVariationPrice(row) ?? updateData.price;
                    const varSale = salePricing.rowSales[rowIndex] ?? null;
                    const stockInputEl = row.querySelector('.var-stock');
                    const varStock = parseInt(stockInputEl.value, 10) || 0;
                    const originalRaw = stockInputEl.dataset.originalStock;
                    const originalVarStock = (originalRaw === undefined || originalRaw === '') ? NaN : Number(originalRaw);
                    const varImage = row.querySelector('.var-image').value.trim();

                    const colorTermId = colorVal ? `term_color_${colorVal.toLowerCase().replace(/\s+/g, '')}` : null;
                    const sizeTermId = sizeVal ? `term_size_${sizeVal.toLowerCase().replace(/\s+/g, '')}` : null;

                    const attributesMap = {};
                    const attributeTerms = [];
                    let varTitleSuffix = [];

                    if (colorVal) {
                        attributesMap['attr_color'] = colorTermId;
                        attributeTerms.push(colorTermId);
                        varTitleSuffix.push(colorVal);
                    }
                    if (sizeVal) {
                        attributesMap['attr_size'] = sizeTermId;
                        attributeTerms.push(sizeTermId);
                        varTitleSuffix.push(sizeVal);
                    }

                    const childProduct = {
                        type: 'variation',
                        parent_id: id,
                        title: `${updateData.title} - ${varTitleSuffix.join(' / ')}`,
                        sku: varSku,
                        price: varPrice,
                        status: updateData.status,
                        image: varImage || primaryImage,
                        attribute_terms: attributeTerms,
                        attributes_map: attributesMap
                    };

                    const comboKey = `${colorTermId || 'none'}_${sizeTermId || 'none'}`;

                    if (existingVariations[comboKey]) {
                        // Update existing variation — stock only under the
                        // concurrency rule above.
                        const varId = existingVariations[comboKey];
                        const adminChangedVarStock = !Number.isFinite(originalVarStock) || varStock !== originalVarStock;

                        if (adminChangedVarStock) {
                            if (Number.isFinite(originalVarStock) && liveVariationStock[varId] !== originalVarStock) {
                                staleStockLabels.push(`${childProduct.title} (τρέχον απόθεμα: ${liveVariationStock[varId]})`);
                            } else {
                                childProduct.stock = varStock;
                            }
                        }

                        childProduct.categories = deleteField();
                        childProduct.category = deleteField();
                        childProduct.subcategoryId = deleteField();
                        childProduct.brand = deleteField();
                        childProduct.updatedAt = serverTimestamp();
                        // Sale present -> written; cleared -> field deleted.
                        childProduct.salePrice = varSale !== null ? varSale : deleteField();
                        batch.update(doc(db, "products", varId), childProduct);
                        delete existingVariations[comboKey]; // Remove from tracking map
                    } else {
                        // Create new variation — nothing to race with yet.
                        const childDocRef = doc(collection(db, "products"));
                        childProduct.stock = varStock;
                        childProduct.createdAt = serverTimestamp();
                        if (varSale !== null) childProduct.salePrice = varSale;
                        batch.set(childDocRef, childProduct);
                    }
                });
            }

            // Delete any remaining obsolete variations (either removed from table, or product became simple)
            Object.values(existingVariations).forEach(varId => {
                batch.delete(doc(db, "products", varId));
            });

            if (staleStockLabels.length > 0) {
                // Nothing has been written: the batch is discarded uncommitted.
                alert('Η αποθήκευση ακυρώθηκε — έγιναν πωλήσεις όσο επεξεργαζόσασταν το απόθεμα:\n\n• '
                    + staleStockLabels.join('\n• ')
                    + '\n\nΚλείστε και ανοίξτε ξανά το προϊόν για να δείτε το τρέχον απόθεμα και ορίστε το ξανά.');
                // The modal re-opens from productsList: load this product's
                // live stock into it so "re-open" really shows current stock.
                await refreshProductFamily(id);
                return; // `finally` restores the save button
            }

            await batch.commit();

            await logAdminAction('UPDATE', 'products', `Ενημέρωση προϊόντος: ${document.getElementById('edit-title').value.trim()}`, { productId: id });

            closeEditModal();
            // Only this product and its variations (was: the whole catalogue).
            await refreshProductFamily(id);
        } catch (error) {
            console.error("Error updating product:", error);
            alert(error.message || "Σφάλμα αποθήκευσης.");
        } finally {
            saveBtn.textContent = originalText;
            saveBtn.disabled = false;
        }
    });

    // ==========================================

    window.addEventListener('adminTabActivated', (e) => {
        if (e.detail.sectionId === 'products-section') {
            // First open loads; re-opens inside PRODUCTS_TAB_MAX_AGE_MS reuse
            // the list (saves keep it current through refreshProductFamily).
            fetchProducts({ maxAgeMs: PRODUCTS_TAB_MAX_AGE_MS });
        }
    });

    // A clicked LOW/OUT-OF-STOCK alert (admin-notifications.js) must open on
    // live stock, not on a list read a few minutes ago.
    window.addEventListener('adminDataStale', (e) => {
        if (e.detail && e.detail.sectionId === 'products-section') productsLoadedAt = 0;
    });

    // Initial load. The products list is NOT read here any more: the
    // dashboard opens on Orders, and the Products tab loads it on first open.
    loadCategoriesForDropdowns();
}
