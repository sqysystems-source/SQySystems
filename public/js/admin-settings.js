// public/js/admin-settings.js
//
// Store-wide configuration: shipping costs, free-shipping threshold, active
// couriers, and the product category list.
//
// Both documents written here — settings/shipping and settings/categories —
// are PUBLIC-READ and consumed live by the storefront (checkout.js,
// global.js navbar, admin-products.js dropdowns) and by
// api/create-payment.js on every order. A bad value saved here is not a
// cosmetic bug in the admin panel; it is a pricing error on every checkout
// until someone notices. So nothing is saved that has not been validated.

import { db, logAdminAction } from './admin-utils.js';
import {
    doc, getDoc, setDoc, runTransaction, collection, query, where, getCountFromServer
} from "https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js";
import { categoryTree, cleanText } from './category-model.js';
import { subscribeCategoryTree } from './category-store.js';
import { escapeHTML } from './sanitize.js';

// ==========================================
// LIMITS & FIELD DEFINITIONS
// ==========================================

// Upper bounds exist to catch a slipped decimal point (350 instead of 3.50),
// not to express business policy. Raise them if the business ever needs to.
const MAX_SHIPPING_COST = 500;
const MAX_FREE_THRESHOLD = 100000;

const MAX_CATEGORY_NAME_LENGTH = 50;
const MAX_CATEGORIES = 100;
const DEFAULT_CATEGORY_NAMES = ['Seating', 'Tables', 'Decor', 'Lighting', 'Storage'];

const SHIPPING_FIELDS = [
    { key: 'baseCost', inputId: 'shipping-base-cost', label: 'Βασικό Κόστος (Ηπειρωτική)', max: MAX_SHIPPING_COST },
    { key: 'islandCost', inputId: 'shipping-island-cost', label: 'Κόστος για Νησιά', max: MAX_SHIPPING_COST },
    { key: 'remoteCost', inputId: 'shipping-remote-cost', label: 'Κόστος για Δυσπρόσιτα', max: MAX_SHIPPING_COST },
    { key: 'freeThreshold', inputId: 'shipping-free-threshold', label: 'Όριο Δωρεάν Μεταφορικών', max: MAX_FREE_THRESHOLD }
];

const COURIER_FIELDS = [
    { key: 'acsActive', inputId: 'setting-courier-acs' },
    { key: 'eltaActive', inputId: 'setting-courier-elta' },
    { key: 'genikiActive', inputId: 'setting-courier-geniki' },
    { key: 'boxnowActive', inputId: 'setting-courier-boxnow' }
];

const MONEY_ERROR_TEXT = {
    empty: 'είναι κενό',
    invalid: 'δεν είναι έγκυρος αριθμός',
    negative: 'δεν μπορεί να είναι αρνητικό',
    too_large: 'είναι ασυνήθιστα μεγάλο — ελέγξτε την υποδιαστολή'
};

class CategoryError extends Error {}

// ==========================================
// PURE VALIDATORS (exported for tests)
// ==========================================

function roundCents(value) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Parses a money field strictly.
 *
 * The previous code was `parseFloat(input.value) || 0`, which turned every
 * failure into ZERO — and zero is a valid, meaningful shipping cost:
 *   - a field cleared by accident saved €0 → free shipping store-wide
 *   - Firefox returns '' for "3,50" in a type=number input → €0
 *   - "-5" saved as -5 → a negative shipping line that REDUCES order totals,
 *     applied by create-payment.js to every order in that zone
 *   - "350" (meant 3.50) saved without a murmur
 * None of these is now saved; each produces a named error instead.
 *
 * @returns {{ ok: true, value: number } | { ok: false, reason: string }}
 */
export function parseMoneyValue(rawValue, max) {
    const text = String(rawValue ?? '').trim().replace(',', '.');
    if (text === '') return { ok: false, reason: 'empty' };
    if (/^-/.test(text)) return { ok: false, reason: 'negative' };
    if (!/^\d+(?:\.\d+)?$/.test(text)) return { ok: false, reason: 'invalid' };

    const value = Number(text);
    if (!Number.isFinite(value)) return { ok: false, reason: 'invalid' };
    if (value > max) return { ok: false, reason: 'too_large' };

    return { ok: true, value: roundCents(value) };
}

/**
 * Normalises a category name, or returns null when unusable.
 *
 * Names flow into navbar links, Firestore `where('categories', '==', name)`
 * queries and product dropdowns. Collapsing internal whitespace and applying
 * NFC stops "Seating" and "Seating " — or a precomposed and a decomposed
 * "Καθίσματα" — from becoming two categories that look identical and match
 * different products.
 */
export function normalizeCategoryName(rawName) {
    if (typeof rawName !== 'string') return null;

    const name = rawName
        .normalize('NFC')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001F\u007F]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    if (!name || name.length > MAX_CATEGORY_NAME_LENGTH) return null;
    return name;
}

function sameCategoryName(first, second) {
    return first.normalize('NFC').toLocaleLowerCase('el') === second.normalize('NFC').toLocaleLowerCase('el');
}

/**
 * Accepts the legacy string form and the object form, drops anything
 * unusable, and removes duplicates.
 *
 * The old loader passed objects through untouched, so a category object with
 * no `name` crashed the duplicate check (`c.name.toLowerCase()`) and with it
 * the Add button, for good.
 */
export function normalizeCategoryList(list) {
    if (!Array.isArray(list)) return [];

    const normalized = [];
    list.forEach(entry => {
        const rawName = typeof entry === 'string' ? entry : entry?.name;
        const name = normalizeCategoryName(rawName);
        if (!name || normalized.some(existing => sameCategoryName(existing.name, name))) return;

        normalized.push({
            name,
            hasSizes: typeof entry === 'object' && entry !== null && entry.hasSizes === true,
            hasColors: typeof entry === 'object' && entry !== null && entry.hasColors === true,
            subcategories: categoryTree([entry])[0]?.subcategories || []
        });
    });

    return normalized.slice(0, MAX_CATEGORIES);
}

function defaultCategories() {
    return DEFAULT_CATEGORY_NAMES.map(name => ({ name, hasSizes: false, hasColors: false }));
}

// ==========================================
// MODULE
// ==========================================

export function initSettingsModule(context) {
    const form = document.getElementById('shipping-settings-form');
    const freeActiveToggle = document.getElementById('shipping-free-active');
    const saveBtn = document.getElementById('save-shipping-btn');

    // Categories Elements
    const catInput = document.getElementById('new-category-input');
    const addCatBtn = document.getElementById('add-category-btn');
    const catList = document.getElementById('categories-list');
    const catSizesToggle = document.getElementById('new-cat-sizes');
    const catColorsToggle = document.getElementById('new-cat-colors');

    let categories = [];
    let categoriesBusy = false;

    // The values as last loaded from Firestore, so the audit entry records
    // what a change replaced, not only what it became.
    let lastLoadedShipping = null;

    function markFieldInvalid(input, isInvalid) {
        if (!input) return;
        input.classList.toggle('border-red-500', isInvalid);
        input.classList.toggle('border-gray-300', !isInvalid);
        input.setAttribute('aria-invalid', String(isInvalid));
    }

    // ------------------------------------------------------------------
    // CATEGORIES
    // ------------------------------------------------------------------

    function setCategoriesBusy(isBusy) {
        categoriesBusy = isBusy;
        if (addCatBtn) {
            addCatBtn.disabled = isBusy;
            addCatBtn.classList.toggle('opacity-50', isBusy);
        }
        if (catList) {
            catList.querySelectorAll('.delete-cat-btn').forEach(button => { button.disabled = isBusy; });
        }
    }

    async function loadCategories() {
        try {
            const snap = await getDoc(doc(db, 'settings', 'categories'));
            categories = snap.exists()
                ? normalizeCategoryList(snap.data().list)
                : defaultCategories();
            renderCategories();
        } catch (error) {
            console.error("Error loading categories:", error);
        }
    }

    function renderCategories() {
        if (!catList) return;
        if (categories.length === 0) {
            catList.innerHTML = '<li class="p-4 text-sm text-neutral-500 text-center">Δεν υπάρχουν κατηγορίες.</li>';
            return;
        }
        catList.innerHTML = categories.map((cat, idx) => `
            <li class="p-4 hover:bg-neutral-50 transition-colors"><div class="flex justify-between items-center">
                <div class="flex items-center gap-3">
                    <span class="font-sans text-sm text-neutral-900">${escapeHTML(cat.name)}</span>
                    ${cat.hasSizes ? '<span class="px-2 py-0.5 bg-stone-100 text-stone-600 border border-stone-200 rounded text-[10px] uppercase font-bold tracking-wider">Μεγέθη</span>' : ''}
                    ${cat.hasColors ? '<span class="px-2 py-0.5 bg-stone-100 text-stone-600 border border-stone-200 rounded text-[10px] uppercase font-bold tracking-wider">Χρώματα</span>' : ''}
                </div>
                <button type="button" class="delete-cat-btn text-red-400 hover:text-red-700 transition-colors" data-index="${idx}" aria-label="Διαγραφή κατηγορίας ${escapeHTML(cat.name)}" ${categoriesBusy ? 'disabled' : ''}>
                    <svg class="w-4 h-4 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                </button>
                </div>
                <ul class="ml-6 mt-3 space-y-2">${(cat.subcategories || []).map(sub => `
                    <li class="flex flex-wrap gap-3 items-center text-sm">
                        <span>${escapeHTML(sub.name)}${sub.archived ? ' (αρχειοθετημένη)' : ''}</span>
                        ${!sub.archived ? `<button type="button" data-sub-action="rename" data-parent="${escapeHTML(cat.name)}" data-sub-id="${escapeHTML(sub.id)}" class="underline">Μετονομασία</button>
                        <button type="button" data-sub-action="archive" data-parent="${escapeHTML(cat.name)}" data-sub-id="${escapeHTML(sub.id)}" class="text-red-700 underline">Διαγραφή</button>` : ''}
                    </li>`).join('')}</ul>
                <button type="button" data-sub-action="add" data-parent="${escapeHTML(cat.name)}" class="ml-6 mt-3 text-sm underline">+ Υποκατηγορία</button>
            </li>
        `).join('');
    }

    /**
     * Read-modify-write of the category list inside a transaction.
     *
     * The previous flow mutated the local array, re-rendered, then wrote the
     * WHOLE local list back with setDoc(). Two consequences:
     *   1. Two admins (or two tabs) editing categories silently erased each
     *      other's changes — last write wins, over the entire list.
     *   2. When the write failed, the local array had already changed. The
     *      screen showed a category that did not exist in Firestore — and the
     *      next successful save quietly persisted the stale list.
     * The transaction re-reads the current list and applies ONE operation to
     * it, and the UI only changes to what Firestore confirmed.
     */
    async function mutateCategories(mutator) {
        const categoriesRef = doc(db, 'settings', 'categories');

        return runTransaction(db, async (transaction) => {
            const snap = await transaction.get(categoriesRef);
            const current = snap.exists()
                ? normalizeCategoryList(snap.data().list)
                : defaultCategories();

            const next = mutator(current.map(category => ({ ...category })));
            transaction.set(categoriesRef, { list: next, revision: (Number(snap.data()?.revision) || 0) + 1 }, { merge: true });
            return next;
        });
    }

    if (addCatBtn) {
        addCatBtn.addEventListener('click', async () => {
            if (categoriesBusy) return;

            const name = normalizeCategoryName(catInput ? catInput.value : '');
            if (!name) {
                alert(`Μη έγκυρο όνομα κατηγορίας. Επιτρέπονται 1–${MAX_CATEGORY_NAME_LENGTH} χαρακτήρες.`);
                return;
            }

            const hasSizes = catSizesToggle ? catSizesToggle.checked : false;
            const hasColors = catColorsToggle ? catColorsToggle.checked : false;

            setCategoriesBusy(true);
            try {
                const next = await mutateCategories(list => {
                    if (list.some(category => sameCategoryName(category.name, name))) {
                        throw new CategoryError('Η κατηγορία υπάρχει ήδη.');
                    }
                    if (list.length >= MAX_CATEGORIES) {
                        throw new CategoryError(`Έχει συμπληρωθεί το μέγιστο όριο των ${MAX_CATEGORIES} κατηγοριών.`);
                    }
                    return [...list, { name, hasSizes, hasColors }];
                });

                categories = next;
                if (catInput) catInput.value = '';
                if (catSizesToggle) catSizesToggle.checked = false;
                if (catColorsToggle) catColorsToggle.checked = false;
                renderCategories();

                await logAdminAction('UPDATE', 'system', `Προσθήκη κατηγορίας: ${name}`, {
                    added: { name, hasSizes, hasColors },
                    categories: next
                });
            } catch (error) {
                if (error instanceof CategoryError) {
                    alert(error.message);
                } else {
                    console.error("Error saving categories:", error);
                    alert('Σφάλμα κατά την αποθήκευση των κατηγοριών.');
                }
                // Show what Firestore actually holds, whatever happened.
                await loadCategories();
            } finally {
                setCategoriesBusy(false);
                renderCategories();
            }
        });
    }

    subscribeCategoryTree(tree => {
        categories = normalizeCategoryList(tree);
        renderCategories();
    });

    if (catList) catList.addEventListener('click', async event => {
        const button = event.target.closest('[data-sub-action]');
        if (!button || categoriesBusy) return;
        const { parent, subId, subAction: action } = button.dataset;
        const original = categories.find(c => c.name === parent)?.subcategories.find(s => s.id === subId);
        let name = '';
        if (action !== 'archive') {
            const input = prompt(action === 'add' ? 'Όνομα υποκατηγορίας (1–50 χαρακτήρες):' : 'Νέο όνομα:', original?.name || '');
            if (input === null) return;
            try { name = cleanText(input, 50); } catch (error) { alert(error.message); return; }
            if (!name) { alert('Το όνομα είναι υποχρεωτικό.'); return; }
        } else if (!confirm(`Διαγραφή της υποκατηγορίας «${original?.name}»; Θα αρχειοθετηθεί και θα κρυφτεί από τα μενού και τις νέες αναθέσεις. Τα προϊόντα παραμένουν στην κύρια κατηγορία και τα παλιά links συνεχίζουν να λειτουργούν. Καμία ανάθεση δεν αλλάζει.`)) return;
        const newId = action === 'add' ? crypto.randomUUID() : null;
        setCategoriesBusy(true);
        try {
            categories = await mutateCategories(list => {
                const category = list.find(c => c.name === parent);
                if (!category) throw new CategoryError('Η κύρια κατηγορία διαγράφηκε. Ανανεώστε τη σελίδα.');
                const children = [...(category.subcategories || [])];
                const child = children.find(s => s.id === subId);
                if (action !== 'add' && (!child || child.archived || child.name !== original?.name)) {
                    throw new CategoryError('Η υποκατηγορία άλλαξε σε άλλη καρτέλα. Δοκιμάστε ξανά με τα νέα στοιχεία.');
                }
                if (action !== 'archive' && children.some(s => s.id !== subId && sameCategoryName(s.name, name))) {
                    throw new CategoryError('Το όνομα υπάρχει ήδη σε αυτή την κατηγορία (ενδεχομένως αρχειοθετημένο).');
                }
                if (action === 'add') {
                    if (children.length >= 100) throw new CategoryError('Μέγιστο 100 υποκατηγορίες ανά κατηγορία, μαζί με τις αρχειοθετημένες.');
                    children.push({ id: newId, name, archived: false });
                } else {
                    const index = children.findIndex(s => s.id === subId);
                    children[index] = { ...child, ...(action === 'archive' ? { archived: true } : { name }) };
                }
                category.subcategories = children;
                return list;
            });
            renderCategories();
            await logAdminAction('UPDATE', 'system', `Υποκατηγορία: ${action}`, { parent, subcategoryId: subId || newId });
        } catch (error) { alert(error.message); await loadCategories(); }
        finally { setCategoriesBusy(false); renderCategories(); }
    });

    if (catList) {
        catList.addEventListener('click', async (e) => {
            const btn = e.target.closest('.delete-cat-btn');
            if (!btn || categoriesBusy) return;

            // Resolve the index to a NAME immediately; the transaction deletes
            // by name, so a list that changed underneath cannot make this
            // delete a different category. (The old code spliced by the
            // string index from the DOM against whatever the local array
            // held by then.)
            const target = categories[Number(btn.getAttribute('data-index'))];
            if (!target) return;
            if (target.subcategories?.length) { alert('Η κατηγορία έχει υποκατηγορίες. Διατηρείται για να παραμείνουν έγκυρες οι αναθέσεις προϊόντων και τα παλιά links.'); return; }

            // Deleting a category does not touch the products filed under it:
            // they keep `categories: "<name>"` and simply vanish from the
            // navbar and the collection filter. Say how many before asking.
            let usageCount = null;
            try {
                const usage = await getCountFromServer(query(
                    collection(db, 'products'),
                    where('categories', '==', target.name)
                ));
                usageCount = usage.data().count;
            } catch (countError) {
                console.warn('Could not count products in category:', countError);
            }

            const message = usageCount > 0
                ? `Η κατηγορία "${target.name}" χρησιμοποιείται από ${usageCount} προϊόντα.\n\nΑν τη διαγράψετε, τα προϊόντα αυτά θα παραμείνουν, αλλά δεν θα εμφανίζονται πλέον στο μενού κατηγοριών. Συνέχεια;`
                : `Διαγραφή της κατηγορίας "${target.name}";`;

            if (!confirm(message)) return;

            setCategoriesBusy(true);
            try {
                const next = await mutateCategories(list => {
                    if (list.find(c => c.name === target.name)?.subcategories?.length) throw new CategoryError('Προστέθηκαν υποκατηγορίες σε άλλη καρτέλα. Η διαγραφή ακυρώθηκε.');
                    return list.filter(category => !sameCategoryName(category.name, target.name));
                });
                categories = next;
                renderCategories();

                await logAdminAction('UPDATE', 'system', `Διαγραφή κατηγορίας: ${target.name}`, {
                    removed: target,
                    productsStillUsingIt: usageCount,
                    categories: next
                });
            } catch (error) {
                console.error("Error deleting category:", error);
                alert('Σφάλμα κατά τη διαγραφή της κατηγορίας.');
                await loadCategories();
            } finally {
                setCategoriesBusy(false);
                renderCategories();
            }
        });
    }

    // ------------------------------------------------------------------
    // SHIPPING
    // ------------------------------------------------------------------

    async function loadSettings() {
        try {
            const snap = await getDoc(doc(db, 'settings', 'shipping'));
            const data = snap.exists() ? snap.data() : {};
            lastLoadedShipping = snap.exists() ? { ...data } : null;

            SHIPPING_FIELDS.forEach(field => {
                const input = document.getElementById(field.inputId);
                if (input && data[field.key] !== undefined) input.value = data[field.key];
            });

            if (freeActiveToggle && data.freeActive !== undefined) {
                freeActiveToggle.checked = data.freeActive === true;
            }

            // Couriers default to active when the field (or the whole
            // document) is missing.
            COURIER_FIELDS.forEach(field => {
                const toggle = document.getElementById(field.inputId);
                if (toggle) toggle.checked = data[field.key] !== false;
            });
        } catch (error) {
            console.error("Error loading shipping settings:", error);
        }
    }

    /**
     * Validates the whole form. Returns the document to save, or the list of
     * problems. Nothing is written unless every field passes.
     */
    function collectShippingSettings() {
        const errors = [];
        const settingsData = {};

        SHIPPING_FIELDS.forEach(field => {
            const input = document.getElementById(field.inputId);
            const result = parseMoneyValue(input ? input.value : '', field.max);
            markFieldInvalid(input, !result.ok);

            if (result.ok) {
                settingsData[field.key] = result.value;
            } else {
                errors.push(`${field.label}: ${MONEY_ERROR_TEXT[result.reason] || 'δεν είναι έγκυρο'}`);
            }
        });

        settingsData.freeActive = Boolean(freeActiveToggle && freeActiveToggle.checked);
        COURIER_FIELDS.forEach(field => {
            const toggle = document.getElementById(field.inputId);
            settingsData[field.key] = Boolean(toggle && toggle.checked);
        });

        // Free shipping switched on with a €0 threshold makes EVERY order
        // ship free. That is occasionally deliberate, far more often a
        // cleared field; require it to be spelled out as a positive number.
        if (settingsData.freeActive && settingsData.freeThreshold !== undefined && settingsData.freeThreshold <= 0) {
            markFieldInvalid(document.getElementById('shipping-free-threshold'), true);
            errors.push('Όριο Δωρεάν Μεταφορικών: πρέπει να είναι μεγαλύτερο από 0 όταν οι δωρεάν αποστολές είναι ενεργές — αλλιώς κάθε παραγγελία αποστέλλεται δωρεάν.');
        }

        // With every courier disabled, checkout.js hides every option and the
        // shopper cannot place any order at all.
        if (!COURIER_FIELDS.some(field => settingsData[field.key])) {
            errors.push('Πρέπει να παραμείνει ενεργή τουλάχιστον μία μεταφορική εταιρεία — αλλιώς το ταμείο δεν μπορεί να ολοκληρώσει καμία παραγγελία.');
        }

        return { errors, settingsData };
    }

    SHIPPING_FIELDS.forEach(field => {
        const input = document.getElementById(field.inputId);
        if (input) input.addEventListener('input', () => markFieldInvalid(input, false));
    });

    if (form && saveBtn) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (saveBtn.disabled) return;

            const { errors, settingsData } = collectShippingSettings();
            if (errors.length > 0) {
                alert(`Οι ρυθμίσεις ΔΕΝ αποθηκεύτηκαν:\n\n• ${errors.join('\n• ')}`);
                return;
            }

            const originalText = saveBtn.textContent;
            saveBtn.textContent = 'Αποθήκευση...';
            saveBtn.disabled = true;

            try {
                await setDoc(doc(db, 'settings', 'shipping'), settingsData, { merge: true });

                await logAdminAction('UPDATE', 'system', 'Ενημέρωση ρυθμίσεων αποστολής (και μεταφορικών).', {
                    previous: lastLoadedShipping,
                    updated: settingsData
                });
                lastLoadedShipping = { ...(lastLoadedShipping || {}), ...settingsData };

                alert('Οι ρυθμίσεις αποθηκεύτηκαν επιτυχώς!');
            } catch (error) {
                console.error("Error saving shipping settings:", error);
                alert('Σφάλμα κατά την αποθήκευση των ρυθμίσεων.');
            } finally {
                saveBtn.textContent = originalText;
                saveBtn.disabled = false;
            }
        });
    }

    // Initial load
    loadSettings();
    loadCategories();
}
