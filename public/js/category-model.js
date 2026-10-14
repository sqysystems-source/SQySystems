// One-level taxonomy. Parent names remain the existing exact product.categories.
// Child IDs are immutable; archived children remain resolvable for old products/URLs.
export function cleanText(value, max = 80) {
    if (value == null) return '';
    if (typeof value !== 'string') throw new Error('Το πεδίο πρέπει να είναι κείμενο.');
    const text = value.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
    if (text.length > max) throw new Error(`Μέγιστο μήκος: ${max} χαρακτήρες.`);
    return text;
}
export function categoryTree(list) {
    return (Array.isArray(list) ? list : []).flatMap(entry => {
        const cat = typeof entry === 'string' ? { name: entry } : entry;
        if (!cat || typeof cat.name !== 'string' || !cat.name) return [];
        return [{ ...cat, subcategories: (Array.isArray(cat.subcategories) ? cat.subcategories : [])
            .filter(s => s && typeof s.id === 'string' && typeof s.name === 'string')
            .map(s => ({ id: s.id, name: s.name, archived: s.archived === true })) }];
    });
}
export function findSubcategory(tree, parent, id) {
    return tree.find(c => c.name === parent)?.subcategories?.find(s => s.id === id);
}
export function optionalProductFields(tree, parent, subcategoryId, brand, { previous, allowArchived = false } = {}) {
    const result = {};
    const brandValue = cleanText(brand);
    if (brandValue) result.brand = brandValue;
    if (!parent || (!tree.some(c => c.name === parent) && previous?.categories !== parent)) {
        throw new Error('Επιλέξτε έγκυρη κύρια κατηγορία.');
    }
    if (subcategoryId) {
        const child = findSubcategory(tree, parent, subcategoryId);
        const unchanged = previous?.categories === parent && previous?.subcategoryId === subcategoryId;
        if (!child || (child.archived && !unchanged && !allowArchived)) {
            throw new Error('Η υποκατηγορία δεν είναι διαθέσιμη για αυτή την κατηγορία.');
        }
        result.subcategoryId = child.id;
    }
    return result;
}
export function matchesCategory(product, parents, children) {
    if (!parents.length && !children.length) return true;
    return parents.includes(product.categories) || children.some(s =>
        product.categories === s.parent && product.subcategoryId === s.id);
}
export function categoryUrl(parent, id = '') {
    const params = new URLSearchParams({ category: parent });
    if (id) params.set('subcategory', id);
    return `collection.html?${params}`;
}
// Query parameters are authoritative, including missing/archived references:
// an unknown child URL must produce zero results, never broaden to its parent.
export function selectionFromParams(params, tree) {
    // Legacy URLs accepted case-insensitive parent names. Resolve them to
    // the configured exact name once; product matching remains strict.
    const key = value => value.normalize('NFC').toLocaleLowerCase('el');
    const parents = [...new Set(params.getAll('category').map(name =>
        tree.find(cat => key(cat.name) === key(name))?.name || name))];
    const children = [...new Set(params.getAll('subcategory'))].map(id => {
        const owner = tree.find(c => parents.includes(c.name) && c.subcategories.some(s => s.id === id));
        return { parent: owner?.name || (parents.length === 1 ? parents[0] : ''), id };
    });
    return { parents: parents.filter(p => !children.some(s => s.parent === p)), children };
}
export function importOptionalFields(row, tree) {
    if (row.type === 'variation') return {}; // Variations inherit their parent's taxonomy/brand.
    const parent = String(row.category || row.categories || '').trim();
    let id = String(row.subcategoryId || '').trim();
    const name = cleanText(row.subcategory || '', 50);
    if (!id && name) {
        const matches = tree.find(c => c.name === parent)?.subcategories.filter(s => s.name === name) || [];
        if (matches.length !== 1) throw new Error('Άγνωστη ή αμφίσημη υποκατηγορία: ' + name);
        id = matches[0].id;
    }
    // IDs are authoritative: old exports remain valid after a rename.
    // Names are resolved only when no ID is supplied.
    // Explicit IDs support faithful export/import, including archived assignments.
    return optionalProductFields(tree, parent, id, row.brand || '', { allowArchived: Boolean(row.subcategoryId) });
}

// Quoting alone does not prevent spreadsheet formula execution. Escape the
// leading apostrophe as well, so our raw CSV export/import remains reversible.
export function encodeCsvCell(value) {
    if (value == null) value = '';
    if (Array.isArray(value)) value = value.join(';');
    let text = String(value);
    if (typeof value === 'string' && /^(?:[=+@'\-]|\s+[=+@\-])/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
}
export function decodeCsvText(value) {
    return typeof value === 'string' && /^'(?:[=+@'\-]|\s+[=+@\-])/.test(value) ? value.slice(1) : value;
}

// Preserve the existing variable-family shape on CSV round trips. Only the
// application's two supported option axes and bounded plain strings are read.
export function importVariationFields(row, type) {
    const result = {};
    const parse = key => {
        if (!row[key]) return undefined;
        try { return JSON.parse(row[key]); }
        catch { throw new Error(`Μη έγκυρο JSON: ${key}`); }
    };
    const axes = new Set(['attr_color', 'attr_size']);
    if (type === 'variable') {
        const attributes = parse('variation_attributes');
        if (attributes !== undefined) {
            if (!Array.isArray(attributes) || attributes.length > 2) throw new Error('Μη έγκυρα variation_attributes.');
            result.variation_attributes = attributes.map(attribute => {
                if (!axes.has(attribute?.attribute_id) || !Array.isArray(attribute.terms) || attribute.terms.length > 50) throw new Error('Μη έγκυρος άξονας παραλλαγών.');
                return { attribute_id: attribute.attribute_id, name: cleanText(attribute.name, 50), terms: attribute.terms.map(term => {
                    const id = cleanText(term?.id, 200), value = cleanText(term?.value, 80);
                    if (!id || !value) throw new Error('Κενή τιμή παραλλαγής.');
                    return { id, value };
                }) };
            });
        }
    }
    if (type === 'variation') {
        const map = parse('attributes_map');
        if (map !== undefined) {
            if (!map || Array.isArray(map) || typeof map !== 'object' || Object.keys(map).some(key => !axes.has(key))) throw new Error('Μη έγκυρο attributes_map.');
            result.attributes_map = Object.fromEntries(Object.entries(map).map(([key, value]) => {
                const term = cleanText(value, 200);
                if (!term) throw new Error('Κενή τιμή παραλλαγής.');
                return [key, term];
            }));
            result.attribute_terms = Object.values(result.attributes_map);
        }
    }
    return result;
}
