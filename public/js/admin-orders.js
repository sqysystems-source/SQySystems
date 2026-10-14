// public/js/admin-orders.js
//
// Orders lifecycle: fetch, filter, render, scroll sync, tracking-number
// updates + EmailJS dispatch, status transitions, and jsPDF export.
//
// Depends only on admin-utils.js — one-directional, no cycles.
// Every DOM listener is registered inside initOrdersModule(), which the
// orchestrator calls ONLY after admin identity is verified. Nothing in this
// module has side effects at import time.

import { db, logAdminAction, getCurrentUser } from './admin-utils.js';
import { collection, getDocs, getDoc, doc, updateDoc, query, orderBy, limit, startAfter, where } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js";
import { escapeHTML } from './sanitize.js';

// The Orders tab is the dashboard's landing tab, and it used to read EVERY
// order ever placed (abandoned card attempts included) on each dashboard
// load, on every click of the tab, and again after every status change — a
// cost that grew forever with the order history. Now: newest first, one page
// at a time, and a re-click reuses the list unless it is older than
// ORDERS_TAB_MAX_AGE_MS or admin-notifications.js reported a new/changed order.
const ORDERS_PAGE_SIZE = 100;
const ORDERS_TAB_MAX_AGE_MS = 5 * 60 * 1000;

// Search beyond the loaded pages. The boxes filter the orders in memory, so
// with paging an order older than the newest ORDERS_PAGE_SIZE was reported as
// "not found" even though it exists. When the loaded pages have no match and
// older pages exist, ONE exact-match query answers the search instead:
// a full order id, a Viva order code, a full e-mail address, or a day.
const ORDER_SEARCH_DEBOUNCE_MS = 500;
const ORDER_ID_LOOKUP_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;
const VIVA_CODE_LOOKUP_PATTERN = /^\d{10,20}$/;
const EMAIL_LOOKUP_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_LOOKUP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ORDER_SEARCH_LOOKUP_LIMIT = 50;

// Module scope: the navigation handler in admin.js calls syncScrollWidths()
// when the Orders tab is shown, so it must be reachable outside init.
const topScroll = document.getElementById('top-scroll-container');
const topScrollContent = document.getElementById('top-scroll-content');
const tableWrapper = document.getElementById('orders-table-wrapper');
const ordersTable = document.getElementById('orders-table');
const ordersSection = document.getElementById('orders-section');

export function syncScrollWidths() {
    if (ordersTable && topScrollContent && !ordersSection.classList.contains('hidden')) {
        topScrollContent.style.width = ordersTable.offsetWidth + 'px';
    }
}


/**
 * Wires the Orders tab and performs its initial load.
 * @param {{ currentUser: import('firebase/auth').User }} context
 */
export function initOrdersModule(context) {
    let allOrders = [];
    let filteredOrders = [];
    const ordersTableBody = document.getElementById('orders-table-body');
    const orderSearchId = document.getElementById('order-search-id');
    const orderSearchEmail = document.getElementById('order-search-email');
    const orderSearchDate = document.getElementById('order-search-date');
    const orderSearchResetBtn = document.getElementById('order-search-reset-btn');
    const exportPdfBtn = document.getElementById('export-pdf-btn');


    // 3. ORDERS MANAGEMENT (Search, Filter, PDF, Scroll Sync)
    // ==========================================
    
    
    window.addEventListener('resize', syncScrollWidths);

    let isSyncingLeftScroll = false;
    let isSyncingRightScroll = false;

    if (topScroll && tableWrapper) {
        topScroll.addEventListener('scroll', function() {
            if (!isSyncingLeftScroll) {
                isSyncingRightScroll = true;
                tableWrapper.scrollLeft = this.scrollLeft;
            }
            isSyncingLeftScroll = false;
        });

        tableWrapper.addEventListener('scroll', function() {
            if (!isSyncingRightScroll) {
                isSyncingLeftScroll = true;
                topScroll.scrollLeft = this.scrollLeft;
            }
            isSyncingRightScroll = false;
        });
    }

    let ordersLoadedAt = 0;
    let ordersStale = false;
    // Search terms already answered by a server lookup for the current list.
    const completedSearchLookups = new Set();
    let searchLookupTimer = null;

    // Αν η παραγγελία είναι "pending" (παράτησε το καλάθι στο Χ),
    // αγνόησέ την — ΕΚΤΟΣ αν έχει σημανθεί για έλεγχο. Το webhook της
    // Viva αφήνει σε 'pending' παραγγελίες με AMOUNT_MISMATCH αφού ο
    // πελάτης έχει ήδη χρεωθεί· αυτές πρέπει να φαίνονται πάντα.
    // 'failed' = a card attempt Viva never charged. Listing it beside
    // real orders, with Paid/Shipped buttons, invites shipping unpaid
    // goods. Flagged orders (AMOUNT_MISMATCH etc.) always stay visible.
    function isHiddenOrder(data) {
        return (data.status === 'pending' || data.status === 'failed') && data.flaggedForReview !== true;
    }
    let lastOrderCursor = null;   // last RAW document of the loaded pages
    let hasMoreOrders = false;
    let isFetchingOrders = false;

    // "Load older" control, created once under the table (no admin.html change).
    const loadOlderWrap = document.createElement('div');
    loadOlderWrap.className = 'hidden justify-center mt-6';
    loadOlderWrap.innerHTML = '<button type="button" class="font-sans text-xs tracking-widest uppercase border border-gray-300 text-neutral-600 px-8 py-3 hover:bg-neutral-50 transition-colors rounded-sm">Φόρτωση παλαιότερων παραγγελιών</button>';
    const loadOlderBtn = loadOlderWrap.querySelector('button');
    if (tableWrapper) tableWrapper.insertAdjacentElement('afterend', loadOlderWrap);

    function updateLoadOlderVisibility() {
        loadOlderWrap.classList.toggle('hidden', !hasMoreOrders);
        loadOlderWrap.classList.toggle('flex', hasMoreOrders);
    }

    /**
     * Reads one page of orders, newest first (ORDERS_PAGE_SIZE billed reads,
     * was: the entire history). `append` continues after the last page.
     * Search, date filter and PDF export work on the loaded orders; "Load
     * older" extends them, and an exact id / Viva code / e-mail / day with no
     * match in them is looked up once (runServerOrderLookup).
     */
    async function fetchOrders({ append = false } = {}) {
        if (isFetchingOrders) return;
        isFetchingOrders = true;

        if (!append) {
            ordersTableBody.innerHTML = `<tr><td colspan="8" class="p-8 text-center text-neutral-400">Φόρτωση παραγγελιών...</td></tr>`;
        }
        loadOlderBtn.disabled = true;

        try {
            const constraints = [orderBy("createdAt", "desc")];
            if (append && lastOrderCursor) constraints.push(startAfter(lastOrderCursor));
            constraints.push(limit(ORDERS_PAGE_SIZE));
            const querySnapshot = await getDocs(query(collection(db, "orders"), ...constraints));

            const pageOrders = [];
            querySnapshot.forEach((docSnap) => {
                const data = docSnap.data();
                if (isHiddenOrder(data)) return;
                pageOrders.push({ id: docSnap.id, ...data });
            });

            if (append) {
                const knownIds = new Set(allOrders.map(order => order.id));
                allOrders = allOrders.concat(pageOrders.filter(order => !knownIds.has(order.id)));
            } else {
                allOrders = pageOrders;
                ordersLoadedAt = Date.now();
                ordersStale = false;
                // Lookups merged into the previous list are gone with it.
                completedSearchLookups.clear();
            }

            if (querySnapshot.docs.length) lastOrderCursor = querySnapshot.docs[querySnapshot.docs.length - 1];
            hasMoreOrders = querySnapshot.docs.length === ORDERS_PAGE_SIZE;

            // Keeps whatever the admin typed in the search boxes applied.
            applyOrderFilters();
        } catch (error) {
            console.error("Error fetching orders:", error);
            if (!append) {
                ordersTableBody.innerHTML = `<tr><td colspan="8" class="p-8 text-center text-red-500">Σφάλμα φόρτωσης παραγγελιών.</td></tr>`;
            }
        } finally {
            isFetchingOrders = false;
            loadOlderBtn.disabled = false;
            updateLoadOlderVisibility();
        }
    }

    loadOlderBtn.addEventListener('click', () => fetchOrders({ append: true }));

    // admin-notifications.js already watches the newest orders live; it
    // dispatches this when one is added or changes, so the next visit to the
    // tab re-reads instead of trusting the list in memory.
    window.addEventListener('adminDataStale', (e) => {
        if (e.detail && e.detail.sectionId === 'orders-section') ordersStale = true;
    });

    function applyOrderFilters() {
        const idTerm = orderSearchId.value.trim().toLowerCase();
        const emailTerm = orderSearchEmail.value.trim().toLowerCase();
        const dateTerm = orderSearchDate.value; 

        filteredOrders = allOrders.filter(order => {
            const matchId = order.id.toLowerCase().includes(idTerm) ||
                            (order.vivaOrderCode && String(order.vivaOrderCode).toLowerCase().includes(idTerm));
            const matchEmail = (order.customer?.email || '').toLowerCase().includes(emailTerm);
            
            let matchDate = true;
            if (dateTerm && order.createdAt) {
                const d = order.createdAt.toDate();
                const orderDateStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
                matchDate = (orderDateStr === dateTerm);
            } else if (dateTerm && !order.createdAt) {
                matchDate = false;
            }

            return matchId && matchEmail && matchDate;
        });

        renderOrdersTable();

        if (filteredOrders.length === 0 && hasMoreOrders) {
            clearTimeout(searchLookupTimer);
            searchLookupTimer = setTimeout(runServerOrderLookup, ORDER_SEARCH_DEBOUNCE_MS);
        }
    }

    /**
     * One exact-match query for a search the loaded pages could not answer
     * (see ORDER_ID_LOOKUP_PATTERN above). Partial terms are not looked up:
     * Firestore has no substring search, and scanning the history is exactly
     * the cost paging removed. Matches are merged into the list (hidden
     * pending/failed attempts stay hidden) and the filters are re-applied.
     */
    async function runServerOrderLookup() {
        if (!hasMoreOrders) return;

        const idTerm = orderSearchId.value.trim();
        const emailTerm = orderSearchEmail.value.trim().toLowerCase();
        const dateTerm = orderSearchDate.value;
        const ordersRef = collection(db, "orders");
        const lookups = [];
        let lookupKey = '';

        if (VIVA_CODE_LOOKUP_PATTERN.test(idTerm)) {
            // create-payment stores the code as a string; orders written
            // before that fix hold a (safe-integer) number.
            lookupKey = `code:${idTerm}`;
            lookups.push(getDocs(query(ordersRef, where("vivaOrderCode", "==", idTerm), limit(ORDER_SEARCH_LOOKUP_LIMIT))));
            const numericCode = Number(idTerm);
            if (Number.isSafeInteger(numericCode)) {
                lookups.push(getDocs(query(ordersRef, where("vivaOrderCode", "==", numericCode), limit(ORDER_SEARCH_LOOKUP_LIMIT))));
            }
        } else if (ORDER_ID_LOOKUP_PATTERN.test(idTerm)) {
            lookupKey = `id:${idTerm}`;
            lookups.push(getDoc(doc(db, "orders", idTerm)));
        } else if (EMAIL_LOOKUP_PATTERN.test(emailTerm)) {
            // create-payment stores customer.email trimmed and lower-cased.
            lookupKey = `email:${emailTerm}`;
            lookups.push(getDocs(query(ordersRef, where("customer.email", "==", emailTerm), limit(ORDER_SEARCH_LOOKUP_LIMIT))));
        } else {
            const dateMatch = DATE_LOOKUP_PATTERN.exec(dateTerm || '');
            if (!dateMatch) return;
            // Local midnight to local midnight: the same day the table's own
            // date filter compares against.
            const dayStart = new Date(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]));
            const dayEnd = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate() + 1);
            lookupKey = `date:${dateTerm}`;
            lookups.push(getDocs(query(
                ordersRef,
                where("createdAt", ">=", dayStart),
                where("createdAt", "<", dayEnd),
                orderBy("createdAt", "desc"),
                limit(ORDERS_PAGE_SIZE)
            )));
        }

        if (!lookupKey || completedSearchLookups.has(lookupKey)) return;
        completedSearchLookups.add(lookupKey);

        try {
            const results = await Promise.all(lookups);
            const knownIds = new Set(allOrders.map(order => order.id));
            const found = [];

            results.forEach((result) => {
                const snaps = typeof result.exists === 'function'
                    ? (result.exists() ? [result] : [])
                    : result.docs;
                snaps.forEach((docSnap) => {
                    const data = docSnap.data();
                    if (knownIds.has(docSnap.id) || isHiddenOrder(data)) return;
                    knownIds.add(docSnap.id);
                    found.push({ id: docSnap.id, ...data });
                });
            });

            if (found.length === 0) return;

            const createdMs = (order) => (order.createdAt && typeof order.createdAt.toMillis === 'function')
                ? order.createdAt.toMillis()
                : 0;
            allOrders = allOrders.concat(found).sort((a, b) => createdMs(b) - createdMs(a));
            applyOrderFilters();
        } catch (error) {
            // Allow the same search to be retried.
            completedSearchLookups.delete(lookupKey);
            console.error("Error searching older orders:", error);
        }
    }

    orderSearchId.addEventListener('input', applyOrderFilters);
    orderSearchEmail.addEventListener('input', applyOrderFilters);
    orderSearchDate.addEventListener('change', applyOrderFilters);

    orderSearchResetBtn.addEventListener('click', () => {
        orderSearchId.value = '';
        orderSearchEmail.value = '';
        orderSearchDate.value = '';
        filteredOrders = [...allOrders];
        renderOrdersTable();
    });

    function renderOrdersTable() {
        if (filteredOrders.length === 0) {
            ordersTableBody.innerHTML = `<tr><td colspan="8" class="p-8 text-center text-neutral-400">Δεν βρέθηκαν παραγγελίες με αυτά τα κριτήρια.</td></tr>`;
            syncScrollWidths();
            return;
        }

        let html = '';
        filteredOrders.forEach((order) => {
            const id = order.id;
            const dateObj = order.createdAt ? order.createdAt.toDate() : new Date();
            const dateStr = dateObj.toLocaleDateString('el-GR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute:'2-digit' });
            
            const customer = order.customer || {};
            
            const docTypeBadge = order.documentType === 'invoice' || (order.invoice && order.invoice.isRequired) 
                ? `<span class="inline-block mt-2 px-2 py-0.5 bg-purple-50 text-purple-700 border border-purple-200 rounded text-[10px] uppercase font-bold tracking-wider">Τιμολόγιο B2B</span>`
                : `<span class="inline-block mt-2 px-2 py-0.5 bg-stone-100 text-stone-600 border border-stone-200 rounded text-[10px] uppercase font-bold tracking-wider">Απόδειξη Λιανικής</span>`;

            let invoiceBlock = '';
            if (order.invoice && order.invoice.isRequired) {
                invoiceBlock = `
                    <div class="mt-2 p-3 bg-white border border-gray-200 rounded-sm text-xs text-neutral-600 shadow-sm">
                        <strong class="text-neutral-900 block mb-1">Στοιχεία Τιμολογίου</strong>
                        Επωνυμία: ${escapeHTML(order.invoice.companyName || 'N/A')}<br>
                        ΑΦΜ: ${escapeHTML(order.invoice.vat || 'N/A')} | ΔΟΥ: ${escapeHTML(order.invoice.taxOffice || 'N/A')}<br>
                        Δραστηριότητα: ${escapeHTML(order.invoice.activity || 'N/A')}
                    </div>
                `;
            }

            const customerStr = `
                <span class="font-medium text-neutral-900">${escapeHTML(customer.firstName || '')} ${escapeHTML(customer.lastName || '')}</span><br>
                <span class="text-xs text-neutral-400">${escapeHTML(customer.email || '')}</span><br>
                <span class="text-xs text-neutral-400">${escapeHTML(customer.phone || '')}</span><br>
                ${docTypeBadge}${invoiceBlock}
            `;
            
            const itemsStr = (order.items || []).map(i => `${escapeHTML(String(i.quantity))}x [${escapeHTML(i.sku || i.title)}]`).join('<br>');
            
            let paymentBadge = '';
            if (order.paymentMethod === 'card') {
                paymentBadge = `
                    <div class="mt-1.5 flex items-center gap-1.5">
                        <span class="px-2 py-0.5 bg-blue-50 text-blue-700 border border-blue-200 rounded text-[10px] uppercase font-bold tracking-wider">
                            Κάρτα (Viva)
                        </span>
                    </div>
                `;
            } else if (order.paymentMethod === 'cod') {
                paymentBadge = `
                    <div class="mt-1.5 flex items-center gap-1.5">
                        <span class="px-2 py-0.5 bg-amber-50 text-amber-800 border border-amber-200 rounded text-[10px] uppercase font-bold tracking-wider">
                            Αντικαταβολή
                        </span>
                        <span class="text-[10px] text-neutral-400 font-normal">(+2.50€)</span>
                    </div>
                `;
            } else {
                paymentBadge = `<span class="block mt-1.5 text-[10px] text-neutral-500 uppercase tracking-widest">${escapeHTML(order.paymentMethod || 'N/A')}</span>`;
            }

            // Shipping Details UI Block
            let shippingDetailsHtml = '';
            if (order.shippingDetails && order.shippingDetails.courier) {
                const courierMap = {
                    'acs': 'ACS Courier',
                    'elta': 'ΕΛΤΑ Courier',
                    'geniki': 'Γενική Ταχυδρομική',
                    'boxnow': 'BoxNow'
                };
                const courierName = courierMap[order.shippingDetails.courier] || order.shippingDetails.courier;
                
                let lockerInfo = '';
                if (order.shippingDetails.courier === 'boxnow' && order.shippingDetails.boxNowLockerId) {
                    lockerInfo = ` <span class="text-[10px] text-neutral-500 font-normal">(Locker: #${escapeHTML(order.shippingDetails.boxNowLockerId)})</span>`;
                }
                
                shippingDetailsHtml = `
                    <div class="mt-1.5 flex items-center gap-1.5">
                        <span class="px-2 py-0.5 bg-stone-100 text-stone-700 border border-stone-200 rounded text-[10px] uppercase font-bold tracking-wider">
                            ${escapeHTML(courierName)}
                        </span>
                        ${lockerInfo}
                    </div>
                `;
            }

            const vivaCodeDisplay = order.vivaOrderCode ? `
                <div class="mt-1.5 flex items-center gap-1 text-[11px] text-neutral-500">
                    <span class="text-[9px] font-sans uppercase tracking-widest text-neutral-400 font-semibold">Viva:</span>
                    <span class="font-mono text-xs text-neutral-800 bg-neutral-100 px-1.5 py-0.5 rounded border border-neutral-200">${escapeHTML(String(order.vivaOrderCode))}</span>
                </div>
            ` : '';

            const trackingHtml = `
                <div class="flex flex-col items-start gap-1">
                    <input type="text" class="tracking-input border-b border-gray-300 py-1 text-xs w-28 bg-transparent focus:outline-none focus:border-neutral-900 font-mono" value="${escapeHTML(order.trackingNumber || '')}" placeholder="Αριθμός...">
                    <button class="save-tracking-btn text-[10px] text-blue-600 hover:text-blue-800 transition-colors uppercase tracking-widest mt-1" data-id="${escapeHTML(id)}">Αποθήκευση</button>
                </div>
            `;

            let statusBadge = '';
            if (order.status === 'pending') {
                statusBadge = `<span class="px-2.5 py-1 bg-amber-50 text-amber-800 border border-amber-200 rounded text-[10px] uppercase font-bold tracking-wider inline-block">Εκκρεμεί</span>`;
            } else if (order.status === 'paid') {
                statusBadge = `<span class="px-2.5 py-1 bg-blue-50 text-blue-700 border border-blue-200 rounded text-[10px] uppercase font-bold tracking-wider inline-block">Πληρώθηκε</span>`;
            } else if (order.status === 'confirmed') {
                statusBadge = `<span class="px-2.5 py-1 bg-stone-100 text-stone-700 border border-stone-300 rounded text-[10px] uppercase font-bold tracking-wider inline-block">Επιβεβαιώθηκε</span>`;
            } else if (order.status === 'shipped') {
                statusBadge = `<span class="px-2.5 py-1 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded text-[10px] uppercase font-bold tracking-wider inline-block">Απεστάλη</span>`;
            } else {
                statusBadge = `<span class="px-2.5 py-1 bg-gray-100 text-gray-600 border border-gray-200 rounded text-[10px] uppercase font-bold tracking-wider inline-block">${escapeHTML(order.status || 'N/A')}</span>`;
            }

            // Webhook review flags (AMOUNT_MISMATCH, DUPLICATE_PAYMENT, OVERSOLD).
            const flagBadge = order.flaggedForReview === true
                ? `<span class="mt-1.5 px-2.5 py-1 bg-red-50 text-red-700 border border-red-200 rounded text-[10px] uppercase font-bold tracking-wider inline-block">⚠ Έλεγχος: ${escapeHTML(order.flagReason || 'REVIEW')}</span>`
                : '';

            html += `
                <tr class="hover:bg-neutral-50 transition-colors align-top border-b border-gray-100">
                    <td class="p-4">
                        <div class="flex items-center gap-2">
                            <span class="font-mono text-xs text-neutral-900 font-medium">${escapeHTML(id)}</span>
                            <button class="copy-id-btn text-neutral-400 hover:text-neutral-900 transition-colors" data-id="${escapeHTML(id)}" title="Αντιγραφή ID">
                                <svg class="w-4 h-4 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg>
                            </button>
                        </div>
                        ${vivaCodeDisplay}
                    </td>
                    <td class="p-4 text-sm text-neutral-600">${escapeHTML(dateStr)}</td>
                    <td class="p-4 text-sm">${customerStr}</td>
                    <td class="p-4 text-xs text-neutral-500 font-mono">${itemsStr}</td>
                    <td class="p-4 text-sm">
                        <div class="font-semibold text-neutral-900">€${(order.totalAmount || 0).toLocaleString('el-GR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                        ${paymentBadge}
                        ${shippingDetailsHtml}
                    </td>
                    <td class="p-4">${trackingHtml}</td>
                    <td class="p-4"><div class="flex flex-col items-start gap-1">${statusBadge}${flagBadge}</div></td>
                    <td class="p-4 text-right space-y-2 flex flex-col items-end">
                        <button class="update-order-btn text-blue-600 hover:text-blue-800 transition-colors underline underline-offset-4 text-[10px] tracking-widest uppercase" data-id="${escapeHTML(id)}" data-status="paid">Σήμανση ως Πληρωμένη</button>
                        <button class="update-order-btn text-stone-600 hover:text-stone-800 transition-colors underline underline-offset-4 text-[10px] tracking-widest uppercase" data-id="${escapeHTML(id)}" data-status="confirmed">Σήμανση ως Επιβεβαιωμένη</button>
                        <button class="update-order-btn text-emerald-600 hover:text-emerald-800 transition-colors underline underline-offset-4 text-[10px] tracking-widest uppercase" data-id="${escapeHTML(id)}" data-status="shipped">Σήμανση ως Απεσταλμένη</button>
                    </td>
                </tr>
            `;
        });
        ordersTableBody.innerHTML = html;
        syncScrollWidths();
    }

    exportPdfBtn.addEventListener('click', async () => {
        const originalText = exportPdfBtn.innerHTML;
        exportPdfBtn.innerHTML = 'Εξαγωγή...';
        exportPdfBtn.disabled = true;

        if (!window.jspdf || !window.jspdf.jsPDF) {
            alert("Η βιβλιοθήκη PDF δεν φορτώθηκε σωστά. Δοκιμάστε ξανά.");
            exportPdfBtn.innerHTML = originalText;
            exportPdfBtn.disabled = false;
            return;
        }

        try {
            const { jsPDF } = window.jspdf;
            const doc = new jsPDF('landscape');
            
            const fontUrl = "https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.7/fonts/Roboto/Roboto-Regular.ttf";
            const response = await fetch(fontUrl);
            const buffer = await response.arrayBuffer();
            const base64Font = btoa(new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), ''));
            
            doc.addFileToVFS("Roboto-Regular.ttf", base64Font);
            doc.addFont("Roboto-Regular.ttf", "Roboto", "normal");
            doc.setFont("Roboto");
            
            doc.setFontSize(16);
            doc.text("AURA Store - Αναφορά Παραγγελιών", 14, 15);
            
            doc.setFontSize(10);
            doc.text(`Ημερομηνία: ${new Date().toLocaleString('el-GR')}`, 14, 22);
            doc.text(`Σύνολο Παραγγελιών: ${filteredOrders.length}`, 14, 27);
            // Only money actually collected or committed. Flagged 'pending'
            // rows are listed for review but are not revenue.
            const REVENUE_STATUSES = ['paid', 'confirmed', 'shipped', 'delivered', 'completed'];
            const totalSum = filteredOrders.reduce(
                (sum, o) => sum + (REVENUE_STATUSES.includes(o.status) ? (Number(o.totalAmount) || 0) : 0),
                0
            );
            doc.text(`Συνολική Αξία: ${totalSum.toLocaleString('el-GR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EUR`, 14, 32);

            const tableData = filteredOrders.map(o => {
                const dateStr = o.createdAt ? o.createdAt.toDate().toLocaleDateString('el-GR') : '';
                const customerStr = `${o.customer?.firstName || ''} ${o.customer?.lastName || ''}\n${o.customer?.email || ''}`;
                const itemsStr = (o.items || []).map(i => `${i.quantity}x [${i.sku || i.title}]`).join('\n');
                
                let paymentInfo = 'N/A';
                if (o.paymentMethod === 'cod') {
                    paymentInfo = 'Αντικαταβολή (+2.50€)';
                } else if (o.paymentMethod === 'card') {
                    paymentInfo = o.vivaOrderCode ? `Κάρτα (Viva: ${o.vivaOrderCode})` : 'Κάρτα (Viva)';
                }

                // Add Courier to PDF
                let shippingInfo = '';
                if (o.shippingDetails && o.shippingDetails.courier) {
                    const courierMap = { 'acs': 'ACS', 'elta': 'ΕΛΤΑ', 'geniki': 'Γενική', 'boxnow': 'BoxNow' };
                    shippingInfo = courierMap[o.shippingDetails.courier] || o.shippingDetails.courier;
                    if (o.shippingDetails.courier === 'boxnow' && o.shippingDetails.boxNowLockerId) {
                        shippingInfo += ` (#${o.shippingDetails.boxNowLockerId})`;
                    }
                    paymentInfo += `\nΜεταφορική: ${shippingInfo}`;
                }
                
                const total = `${(o.totalAmount || 0).toLocaleString('el-GR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EUR`;
                
                let status = o.status;
                if (o.status === 'pending') status = 'Εκκρεμεί';
                else if (o.status === 'paid') status = 'Πληρώθηκε';
                else if (o.status === 'confirmed') status = 'Επιβεβαιώθηκε';
                else if (o.status === 'shipped') status = 'Απεστάλη';
                
                return [o.id, dateStr, customerStr, itemsStr, paymentInfo, total, status];
            });

            doc.autoTable({
                startY: 40,
                head: [['ID', 'Ημερομηνία', 'Πελάτης', 'Προϊόντα', 'Πληρωμή & Αποστολή', 'Σύνολο', 'Κατάσταση']],
                body: tableData,
                styles: { fontSize: 8, font: 'Roboto' },
            });

            doc.save('aura_orders_report.pdf');
            await logAdminAction('EXPORT', 'orders', 'Εξαγωγή παραγγελιών σε PDF.', { count: filteredOrders.length });
        } catch (error) {
            console.error("PDF Export Error:", error);
            alert("Σφάλμα κατά την εξαγωγή του PDF.");
        } finally {
            exportPdfBtn.innerHTML = originalText;
            exportPdfBtn.disabled = false;
        }
    });

    ordersTableBody.addEventListener('click', async (e) => {
        const copyBtn = e.target.closest('.copy-id-btn');
        if (copyBtn) {
            const id = copyBtn.getAttribute('data-id');
            try {
                await navigator.clipboard.writeText(id);
                const originalSvg = copyBtn.innerHTML;
                copyBtn.innerHTML = `<svg class="w-4 h-4 text-green-600 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>`;
                setTimeout(() => {
                    copyBtn.innerHTML = originalSvg;
                }, 2000);
            } catch (err) {
                console.error('Failed to copy ID: ', err);
            }
            return;
        }

        if (e.target.classList.contains('save-tracking-btn')) {
            const btn = e.target;
            const orderId = btn.getAttribute('data-id');
            const inputEl = btn.previousElementSibling;
            const newTracking = inputEl.value.trim();

            const originalText = btn.textContent;
            btn.textContent = '...';
            btn.disabled = true;

            try {
                await updateDoc(doc(db, "orders", orderId), { trackingNumber: newTracking });
                await logAdminAction('UPDATE', 'orders', `Ενημέρωση tracking παραγγελίας #${orderId.slice(0,8)}`, { orderId, trackingNumber: newTracking });
                
                const orderIndex = allOrders.findIndex(o => o.id === orderId);
                let order = null;
                if (orderIndex !== -1) {
                    allOrders[orderIndex].trackingNumber = newTracking;
                    order = allOrders[orderIndex];
                }
                const filteredIndex = filteredOrders.findIndex(o => o.id === orderId);
                if (filteredIndex !== -1) filteredOrders[filteredIndex].trackingNumber = newTracking;

                if (!newTracking) {
                    // Clearing the tracking number is a data edit, not a
                    // shipment: never notify the customer about it.
                    btn.textContent = 'Ενημερώθηκε ✓';
                } else {
                    try {
                        const currentUser = getCurrentUser();
                        let idToken = '';
                        if (currentUser) {
                            idToken = await currentUser.getIdToken();
                        }

                        const emailRes = await fetch('/api/send-email', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                ...(idToken ? { 'Authorization': `Bearer ${idToken}` } : {})
                            },
                            body: JSON.stringify({
                                type: 'order_shipped',
                                orderId: orderId
                            })
                        });

                        const emailData = await emailRes.json().catch(() => ({}));

                        if (!emailRes.ok) {
                            throw new Error(emailData.error || 'Failed to dispatch email via Resend');
                        }

                        // A 200 with a `note` means NOTHING was sent (already
                        // sent for this tracking number, or a send is in
                        // flight). Never report that as a fresh dispatch.
                        btn.textContent = emailData.note
                            ? 'Ενημερώθηκε ✓ (email ήδη σταλμένο)'
                            : 'Ενημερώθηκε & Εστάλη ✓';
                    } catch (emailError) {
                        console.error("Failed to send tracking email:", emailError);
                        alert("Ο κωδικός αποθηκεύτηκε, αλλά το email απέτυχε να σταλεί.");
                        btn.textContent = 'Ενημερώθηκε ✓';
                    }
                }

                btn.classList.replace('text-blue-600', 'text-green-600');
                setTimeout(() => {
                    btn.textContent = 'Αποθήκευση';
                    btn.classList.replace('text-green-600', 'text-blue-600');
                    btn.disabled = false;
                }, 3000);

            } catch (error) {
                console.error("Error saving tracking:", error);
                alert("Σφάλμα αποθήκευσης. Δοκιμάστε ξανά.");
                btn.textContent = originalText;
                btn.disabled = false;
            }
            return;
        }

        if (e.target.classList.contains('update-order-btn')) {
            const orderId = e.target.getAttribute('data-id');
            const newStatus = e.target.getAttribute('data-status');
            
            const statusLabels = {
                paid: 'Πληρώθηκε',
                confirmed: 'Επιβεβαιώθηκε',
                shipped: 'Απεστάλη'
            };
            const targetLabel = statusLabels[newStatus] || newStatus;
            
            if (confirm(`Είστε σίγουροι ότι θέλετε να αλλάξετε την κατάσταση σε '${targetLabel}';`)) {
                try {
                    await updateDoc(doc(db, "orders", orderId), { status: newStatus });
                    await logAdminAction('UPDATE', 'orders', `Αλλαγή κατάστασης παραγγελίας #${orderId.slice(0,8)} σε ${targetLabel}`, { orderId, newStatus });
                    // The write is known exactly: patch the row in memory
                    // (0 reads) instead of re-reading every order — the same
                    // approach the tracking-number save above already uses.
                    [allOrders, filteredOrders].forEach(list => {
                        const order = list.find(entry => entry.id === orderId);
                        if (order) order.status = newStatus;
                    });
                    renderOrdersTable();
                } catch (error) {
                    console.error("Error updating order status:", error);
                    alert("Σφάλμα κατά την ενημέρωση της παραγγελίας.");
                }
            }
        }
    });

    // ==========================================

    window.addEventListener('adminTabActivated', (e) => {
        if (e.detail.sectionId !== 'orders-section') return;
        const isFresh = ordersLoadedAt && !ordersStale && Date.now() - ordersLoadedAt < ORDERS_TAB_MAX_AGE_MS;
        if (!isFresh) fetchOrders();
    });

    // Initial load (was called directly from onAuthStateChanged in the monolith).
    fetchOrders();
}
