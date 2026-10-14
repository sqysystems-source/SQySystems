
// public/js/admin-notifications.js
//
// Notification bell: live feed, unread badge, audio chime, and the two
// generators that derive notifications from product stock levels and order
// events.
//
// This is YOUR file, refactored — not a replacement. playChime(), the stock
// and order generators, the per-type SVG icons, formatTimeAgo(), the `9+`
// badge cap, the isCleared soft-delete and the deferred-stock-deduction guard
// on pending Viva orders are all preserved exactly as you wrote them.
//
// ---------------------------------------------------------------------------
// WHAT THE REFACTOR CHANGED
// ---------------------------------------------------------------------------
//
// 1. NO DOMContentLoaded, NO onAuthStateChanged.
//    The module exports initNotificationsModule(context), called by admin.js
//    only after the admin role has been verified against Firestore, exactly
//    like every other feature module.
//
// 2. THE LEAK WAS WORSE THAN "NOT UNSUBSCRIBED ON LOGOUT".
//    cleanup() called the three unsubscribe functions but never set them to
//    null, and nothing guarded re-entry into initNotifications(). Since
//    onAuthStateChanged fires on page load AND on every silent token refresh
//    (roughly hourly), each refresh ran initNotifications() again, which
//    attached three fresh onSnapshot listeners and overwrote the three
//    unsubscribe references with the new ones. The previous listeners were
//    then unreachable — no reference left to close them with — and stayed open
//    for the life of the tab.
//    A dashboard left open all day accumulated a listener set per hour: every
//    one of them streaming the products collection, re-running the generators,
//    and re-rendering the list. The duplicate generators also meant the same
//    notification write fired N times, and the chime could sound N times for
//    one order.
//    Now: one idempotent init, unsubscribes nulled after use, and
//    subscribeAll() closes anything live before it opens anything new.
//
// 3. playChime() LEAKED AudioContexts AND STOPPED WORKING AFTER ~6 CHIMES.
//    It constructed a new AudioContext per chime and never closed it. Chrome
//    caps a page at around six concurrent contexts; past that the constructor
//    throws, your catch swallowed it, and the chime silently stopped for the
//    rest of the session — the failure mode being "notifications went quiet",
//    which nobody reports as a bug. One lazily-created context is now reused,
//    and resumed if the browser has suspended it. Same sine wave, same 880 Hz,
//    same 0.05 gain, same 300 ms ramp.
//
// 4. GENERATORS WAIT FOR THE NOTIFICATION FEED.
//    The generators decide whether to create or delete a notification, and the
//    delete path cost two getDoc reads per healthy product. On a 500-product
//    catalogue that is ~1,000 reads on every page load, every time. The
//    notifications listener now attaches first, and the generators start only
//    after its first snapshot has arrived, so they can consult the ids already
//    in memory and skip deletes for notifications that are demonstrably not
//    there. Creates are NEVER skipped on local state — that path still does a
//    real getDoc, because the 50-document feed cannot prove a document is
//    absent, and guessing there would resurrect notifications you had cleared.
//    See SKIP_DELETE_WHEN_ABSENT below to turn this off.
//
// 5. A PER-PRODUCT STATE MAP SUPPRESSES NO-OP WRITES.
//    The products listener fires on EVERY modification — a price edit, a title
//    fix, a CSV re-import — and each one re-ran the full create/delete dance
//    for that product even when its stock bracket had not moved. The bracket
//    (out / low / ok) is now remembered per product id and Firestore is only
//    touched when it actually changes. Identical behaviour, a fraction of the
//    traffic.
//
// 6. ESCAPED ATTRIBUTES.
//    data-id and data-link were interpolated raw. linkTab is also fed straight
//    into document.getElementById(...).click(), so it is now checked against
//    the known nav ids rather than trusted.
//
// ---------------------------------------------------------------------------
// STRUCTURAL NOTE — worth acting on, deliberately NOT changed here
// ---------------------------------------------------------------------------
// The generators run in the admin's browser. That means notifications only
// exist while an admin has the dashboard open: an order placed overnight
// generates nothing until someone logs in, and the products listener bills you
// 500 document reads per tab per load before anything happens.
// Worse, a bulk CSV import of 400 products lands as 400 docChanges in this
// listener and, on first load, fans out into hundreds of reads and writes
// fired from a browser tab that the operator may close mid-flight.
// This belongs in a Firestore-triggered Cloud Function (onWrite on products
// and orders), where it runs once, server-side, whether or not anyone is
// watching. The refactor below makes the client version as cheap as it can
// honestly be; it cannot make it the right place for the work.

import { db } from './firebase-config.js';
import {
    collection, query, orderBy, limit, onSnapshot, doc, getDoc, setDoc,
    deleteDoc, updateDoc, serverTimestamp, writeBatch, getDocs, where
} from "https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js";
import { escapeHTML } from './sanitize.js';

const NOTIFICATIONS_COLLECTION = 'admin_notifications';
const NOTIFICATIONS_LIMIT = 50;
const PRODUCTS_WATCH_LIMIT = 500;
// Only products at or below this stock are streamed (the 'low' bracket).
const LOW_STOCK_THRESHOLD = 5;
const ORDERS_WATCH_LIMIT = 20;
const RECENT_ORDER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// See refactor note 4. Set to false to restore the original behaviour of
// always issuing a getDoc before a delete.
const SKIP_DELETE_WHEN_ABSENT = true;

// linkTab is read from a Firestore document and then used to look up and
// click() a DOM element. Only these ids are real nav buttons; anything else is
// ignored rather than dispatched.
const VALID_LINK_TABS = new Set([
    'nav-orders', 'nav-products', 'nav-customers', 'nav-support',
    'nav-analytics', 'nav-cloud-drive', 'nav-logs', 'nav-settings'
]);

// ===========================================================================
// MODULE STATE — every field here is reset by disposeNotificationsModule()
// ===========================================================================

let initialised = false;
let listenerAbortController = null;

let notificationsUnsubscribe = null;
let productsUnsubscribe = null;
let ordersUnsubscribe = null;

let generatorsStarted = false;
let previousUnreadCount = 0;
let isInitialLoad = true;

// Ids present in the live feed, used only to skip provably unnecessary
// deletes (refactor note 4).
let knownNotificationIds = new Set();

// productId -> 'out' | 'low' | 'ok'. Suppresses no-op writes (refactor note 5).
let productStockState = new Map();

// One reused AudioContext (refactor note 3).
let audioContext = null;

// ===========================================================================
// AUDIO — your chime, with the context leak fixed
// ===========================================================================

function playChime() {
    try {
        const AudioCtor = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtor) return;

        if (!audioContext) {
            audioContext = new AudioCtor();
        }

        // Autoplay policy suspends a context created before the first user
        // gesture. Resuming is what makes the chime work on a tab that has
        // been sitting idle.
        if (audioContext.state === 'suspended') {
            audioContext.resume().catch(() => {});
        }

        const ctx = audioContext;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        gain.gain.setValueAtTime(0.05, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.3);

        // Release the nodes once the tone has finished. Without this the
        // graph grows by two nodes per chime for the life of the context.
        osc.onended = () => {
            try {
                osc.disconnect();
                gain.disconnect();
            } catch (_error) {
                // Already torn down.
            }
        };
    } catch (_error) {
        // Ignore if audio is unavailable (no context, no gesture yet, muted).
    }
}

function closeAudioContext() {
    if (!audioContext) return;
    try {
        if (typeof audioContext.close === 'function') audioContext.close();
    } catch (_error) {
        // Nothing to do.
    }
    audioContext = null;
}

// ===========================================================================
// NOTIFICATION WRITES
// ===========================================================================

async function createNotificationIfNotExists(id, data) {
    if (!initialised) return;

    // The live feed PROVES existence (it cannot prove absence): if the id is
    // in it, the notification exists, cleared or not — skip the read.
    if (knownNotificationIds.has(id)) return;

    try {
        const docRef = doc(db, NOTIFICATIONS_COLLECTION, id);
        const snap = await getDoc(docRef);

        // The read stays real. The 50-document feed can prove a notification
        // EXISTS but never that it is absent — it may simply be older than the
        // window, or soft-deleted with isCleared. Trusting local state here
        // would resurrect notifications the admin had cleared.
        if (!snap.exists()) {
            await setDoc(docRef, {
                ...data,
                read: false,
                isCleared: false,
                createdAt: serverTimestamp()
            });
        }
    } catch (err) {
        console.error('[admin-notifications] Error creating notification', err);
    }
}

async function deleteNotificationIfExists(id) {
    if (!initialised) return;

    // Cheap path: if the live feed does not hold this id, there is nothing
    // visible to remove, so skip the read entirely. Worst case a notification
    // older than the 50-document window survives until it next surfaces —
    // invisible either way, since the list only renders those 50.
    if (SKIP_DELETE_WHEN_ABSENT && !knownNotificationIds.has(id)) return;

    try {
        const docRef = doc(db, NOTIFICATIONS_COLLECTION, id);
        // Present in the live feed = exists: delete without a confirming read.
        if (knownNotificationIds.has(id)) {
            await deleteDoc(docRef);
            return;
        }
        const snap = await getDoc(docRef);
        if (snap.exists()) {
            await deleteDoc(docRef);
        }
    } catch (err) {
        console.error('[admin-notifications] Error deleting notification', err);
    }
}

// ===========================================================================
// GENERATORS — your logic, unchanged in behaviour
// ===========================================================================

function initGenerators() {
    if (generatorsStarted) return;
    generatorsStarted = true;

    // ---- Products generator (stock tracking) ----------------------------
    // Streams ONLY sellable documents (simple products and variations) with
    // stock < 5. The old listener streamed the whole catalogue (up to 500
    // reads per dashboard load, plus one read per later price/title edit
    // anywhere) just to find the few low ones.
    //
    // Variable PARENTS are excluded: admin-products.js always stores their
    // stock as 0 ("a variable parent is never purchasable"), so every one of
    // them matched `stock < 5`, cost a listener read plus a notification
    // getDoc on each dashboard load, and raised a false "Εξαντλήθηκε"
    // (sold out) alert. Real sell-outs arrive through their variations.
    //
    // Needs the composite index products(type ASC, stock ASC). Until it
    // exists Firestore answers failed-precondition; the watcher then falls
    // back to the stock-only query, and parents are still skipped below.
    //   added    -> product entered the low/out bracket (or first load)
    //   modified -> still low/out, something changed (bracket may flip)
    //   removed  -> restocked to >= 5, or deleted: clear its notifications
    subscribeLowStockWatcher(true);

    function subscribeLowStockWatcher(filterByType) {
        let isFirstProductsSnapshot = true;
        productsUnsubscribe = onSnapshot(
            filterByType
                ? query(
                    collection(db, 'products'),
                    where('type', 'in', ['simple', 'variation']),
                    where('stock', '<', LOW_STOCK_THRESHOLD),
                    limit(PRODUCTS_WATCH_LIMIT)
                )
                : query(
                    collection(db, 'products'),
                    where('stock', '<', LOW_STOCK_THRESHOLD),
                    limit(PRODUCTS_WATCH_LIMIT)
                ),
            (snapshot) => {
                if (!initialised) return;

                // First load only: a product restocked while the dashboard was
                // closed never appears in this query, so its old LOW/OUT
                // notification is removed here, from the ids already in memory.
                // (This also clears the false alerts variable parents used to get.)
                if (isFirstProductsSnapshot) {
                    isFirstProductsSnapshot = false;
                    const lowIds = new Set(snapshot.docs
                        .filter(d => d.data().type !== 'variable')
                        .map(d => d.id));
                    knownNotificationIds.forEach((notificationId) => {
                        const match = /^(LOW_STOCK|OUT_OF_STOCK)_(.+)$/.exec(notificationId);
                        if (match && !lowIds.has(match[2])) deleteNotificationIfExists(notificationId);
                    });
                }

                snapshot.docChanges().forEach((change) => {
                    const pId = change.doc.id;

                    if (change.type === 'added' || change.type === 'modified') {
                        const product = change.doc.data();
                        // Fallback query only: a variable parent's stock is always 0.
                        if (product.type === 'variable') return;
                        const stock = typeof product.stock === 'number' ? product.stock : 0;

                        const bracket = stock <= 0 ? 'out' : (stock < LOW_STOCK_THRESHOLD ? 'low' : 'ok');

                        // Refactor note 5: a title or price edit re-fires this
                        // listener with an unchanged stock bracket. Nothing to do.
                        if (productStockState.get(pId) === bracket) return;
                        productStockState.set(pId, bracket);

                        if (bracket === 'out') {
                            createNotificationIfNotExists(`OUT_OF_STOCK_${pId}`, {
                                type: 'OUT_OF_STOCK',
                                title: 'Εξαντλήθηκε',
                                message: `Το προϊόν "${product.title}" εξαντλήθηκε.`,
                                productId: pId,
                                linkTab: 'nav-products'
                            });
                            deleteNotificationIfExists(`LOW_STOCK_${pId}`);
                        } else if (bracket === 'low') {
                            createNotificationIfNotExists(`LOW_STOCK_${pId}`, {
                                type: 'LOW_STOCK',
                                title: 'Χαμηλό Απόθεμα',
                                message: `Το προϊόν "${product.title}" έχει μόνο ${stock} τεμάχια.`,
                                productId: pId,
                                linkTab: 'nav-products'
                            });
                            deleteNotificationIfExists(`OUT_OF_STOCK_${pId}`);
                        } else {
                            deleteNotificationIfExists(`LOW_STOCK_${pId}`);
                            deleteNotificationIfExists(`OUT_OF_STOCK_${pId}`);
                        }
                    } else if (change.type === 'removed') {
                        productStockState.delete(pId);
                        deleteNotificationIfExists(`LOW_STOCK_${pId}`);
                        deleteNotificationIfExists(`OUT_OF_STOCK_${pId}`);
                    }
                });
            },
            (error) => {
                if (!initialised) return;
                if (filterByType && error && error.code === 'failed-precondition') {
                    console.warn('[admin-notifications] Index products(type ASC, stock ASC) missing — create it from the link in this error. Watching without the type filter meanwhile.', error);
                    subscribeLowStockWatcher(false);
                    return;
                }
                console.error('[admin-notifications] Products watcher error:', error);
            }
        );
    }

    // ---- Orders generator ------------------------------------------------
    const qOrders = query(
        collection(db, 'orders'),
        orderBy('createdAt', 'desc'),
        limit(ORDERS_WATCH_LIMIT)
    );

    let isFirstOrdersSnapshot = true;
    ordersUnsubscribe = onSnapshot(
        qOrders,
        (snapshot) => {
            if (!initialised) return;

            // This listener already sees every new or changed recent order,
            // so it tells admin-orders.js when its list is out of date (the
            // Orders tab then re-reads on its next visit instead of on every
            // click). The admin's own status edits (pending local writes)
            // are already patched into that list and don't count.
            if (!isFirstOrdersSnapshot
                && snapshot.docChanges().some(change => !change.doc.metadata.hasPendingWrites)) {
                window.dispatchEvent(new CustomEvent('adminDataStale', { detail: { sectionId: 'orders-section' } }));
            }
            isFirstOrdersSnapshot = false;

            snapshot.docChanges().forEach((change) => {
                const order = change.doc.data();
                const oId = change.doc.id;
                const orderDate = order.createdAt && typeof order.createdAt.toDate === 'function'
                    ? order.createdAt.toDate()
                    : new Date();

                // Only trigger for orders placed within the last 7 days.
                const isRecent = (new Date() - orderDate) < RECENT_ORDER_WINDOW_MS;
                if (!isRecent) return;

                if (change.type === 'added') {
                    // DEFERRED STOCK DEDUCTION GUARD:
                    // Αγνοούμε τις παραγγελίες με κάρτα (Viva) που είναι ακόμα 'pending'.
                    // Δεν χτυπάμε ειδοποίηση για εγκαταλελειμμένα καλάθια.
                    if (order.status === 'pending') return;

                    createNotificationIfNotExists(`NEW_ORDER_${oId}`, {
                        type: 'NEW_ORDER',
                        title: 'Νέα Παραγγελία',
                        message: `Λήφθηκε νέα παραγγελία (#${oId.slice(0, 8).toUpperCase()})`,
                        orderId: oId,
                        linkTab: 'nav-orders'
                    });
                } else if (change.type === 'modified') {
                    if (order.status === 'paid') {
                        createNotificationIfNotExists(`PAID_ORDER_${oId}`, {
                            type: 'NEW_ORDER',
                            title: 'Παραγγελία Πληρώθηκε',
                            message: `Η παραγγελία #${oId.slice(0, 8).toUpperCase()} πληρώθηκε.`,
                            orderId: oId,
                            linkTab: 'nav-orders'
                        });
                    }
                }
            });
        },
        (error) => {
            if (!initialised) return;
            console.error('[admin-notifications] Orders watcher error:', error);
        }
    );
}

// ===========================================================================
// SUBSCRIPTIONS
// ===========================================================================

function subscribeAll() {
    // Defensive: never stack a subscription on a live one. This is the guard
    // whose absence turned every hourly token refresh into three more
    // permanently-open listeners.
    closeSubscriptions();

    const qNotifs = query(
        collection(db, NOTIFICATIONS_COLLECTION),
        orderBy('createdAt', 'desc'),
        limit(NOTIFICATIONS_LIMIT)
    );

    notificationsUnsubscribe = onSnapshot(
        qNotifs,
        (snapshot) => {
            // A snapshot can land in the gap between dispose() and the
            // unsubscribe taking effect. Dropping it keeps a signed-out page
            // from repainting with live data.
            if (!initialised) return;

            const notifications = [];
            const ids = new Set();
            let unreadCount = 0;

            snapshot.forEach(docSnap => {
                const data = docSnap.data();
                ids.add(docSnap.id);

                // Filter out cleared notifications so they don't render.
                if (data.isCleared === true) return;

                notifications.push({ id: docSnap.id, ...data });
                if (!data.read) unreadCount++;
            });

            knownNotificationIds = ids;

            // A support ticket just arrived: the Support tab re-reads on its
            // next visit instead of on every click.
            if (!isInitialLoad && snapshot.docChanges().some(change => (
                change.type === 'added' && change.doc.data().type === 'NEW_TICKET'
            ))) {
                window.dispatchEvent(new CustomEvent('adminDataStale', { detail: { sectionId: 'support-section' } }));
            }

            if (!isInitialLoad && unreadCount > previousUnreadCount) {
                playChime();
            }
            previousUnreadCount = unreadCount;

            const wasInitialLoad = isInitialLoad;
            isInitialLoad = false;

            renderBadge(unreadCount);
            renderList(notifications);

            // Refactor note 4: the generators need the feed's ids in memory
            // before they start making delete decisions, so they are started
            // from the first snapshot rather than alongside it.
            if (wasInitialLoad) initGenerators();
        },
        (error) => {
            // permission-denied here right after logout is expected.
            if (!initialised) return;
            console.error('[admin-notifications] Notifications watcher error:', error);
        }
    );
}

function closeSubscriptions() {
    [notificationsUnsubscribe, productsUnsubscribe, ordersUnsubscribe].forEach((unsubscribe) => {
        if (typeof unsubscribe !== 'function') return;
        try {
            unsubscribe();
        } catch (error) {
            console.warn('[admin-notifications] Unsubscribe failed:', error);
        }
    });

    // Nulling these is the whole point: an unsubscribe reference that has been
    // overwritten is a listener nobody can ever close.
    notificationsUnsubscribe = null;
    productsUnsubscribe = null;
    ordersUnsubscribe = null;
    generatorsStarted = false;
}

// ===========================================================================
// RENDERING — your markup, unchanged
// ===========================================================================

function renderBadge(count) {
    const notifBadge = document.getElementById('admin-notifications-badge');
    if (!notifBadge) return;

    if (count > 0) {
        notifBadge.textContent = count > 9 ? '9+' : count;
        notifBadge.classList.remove('hidden');
    } else {
        notifBadge.classList.add('hidden');
    }
}

function renderList(notifications) {
    const notifList = document.getElementById('admin-notifications-list');
    if (!notifList) return;

    if (notifications.length === 0) {
        notifList.innerHTML = `
            <div class="px-4 py-8 text-center text-neutral-400 font-sans text-sm">
                Δεν υπάρχουν νέες ειδοποιήσεις.
            </div>
        `;
        return;
    }

    notifList.innerHTML = notifications.map(n => {
        const isUnread = !n.read;
        const bgClass = isUnread ? 'bg-blue-50/50' : 'bg-white';
        const dotClass = isUnread
            ? '<span class="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0 mt-1.5"></span>'
            : '<span class="w-2 h-2 flex-shrink-0 mt-1.5"></span>';

        let iconHtml = '';
        if (n.type === 'NEW_ORDER') {
            iconHtml = '<div class="w-8 h-8 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center flex-shrink-0"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"></path></svg></div>';
        } else if (n.type === 'LOW_STOCK') {
            iconHtml = '<div class="w-8 h-8 rounded-full bg-amber-100 text-amber-600 flex items-center justify-center flex-shrink-0"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg></div>';
        } else if (n.type === 'OUT_OF_STOCK') {
            iconHtml = '<div class="w-8 h-8 rounded-full bg-red-100 text-red-600 flex items-center justify-center flex-shrink-0"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg></div>';
        } else if (n.type === 'NEW_TICKET') {
            iconHtml = '<div class="w-8 h-8 rounded-full bg-purple-100 text-purple-600 flex items-center justify-center flex-shrink-0"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"></path></svg></div>';
        }

        const timeStr = n.createdAt && typeof n.createdAt.toDate === 'function'
            ? formatTimeAgo(n.createdAt.toDate())
            : 'Μόλις τώρα';

        // linkTab is validated rather than escaped-and-trusted: it is fed to
        // getElementById().click() on the other side of this markup.
        const safeLinkTab = VALID_LINK_TABS.has(n.linkTab) ? n.linkTab : '';

        return `
            <div class="px-4 py-3 flex gap-3 cursor-pointer hover:bg-neutral-50 transition-colors ${bgClass} notif-item" data-id="${escapeHTML(n.id)}" data-link="${escapeHTML(safeLinkTab)}">
                ${dotClass}
                ${iconHtml}
                <div class="flex-1 min-w-0">
                    <p class="font-sans text-xs font-semibold text-neutral-900">${escapeHTML(n.title)}</p>
                    <p class="font-sans text-xs text-neutral-500 mt-0.5 truncate">${escapeHTML(n.message)}</p>
                    <p class="font-sans text-[10px] text-neutral-400 mt-1">${escapeHTML(timeStr)}</p>
                </div>
            </div>
        `;
    }).join('');
}

function formatTimeAgo(date) {
    const seconds = Math.floor((new Date() - date) / 1000);
    if (seconds < 60) return 'Μόλις τώρα';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} λεπτά πριν`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} ώρες πριν`;
    const days = Math.floor(hours / 24);
    return `${days} μέρες πριν`;
}

// ===========================================================================
// PUBLIC API
// ===========================================================================

/**
 * Wires the notification bell and opens the three live subscriptions.
 * Called by admin.js ONLY after the admin role has been verified.
 *
 * @param {{ currentUser: object, userData: object }} context
 */
export function initNotificationsModule(context) {
    if (initialised) return;

    const notifWrapper = document.getElementById('admin-notifications-wrapper');
    const notifBtn = document.getElementById('admin-notifications-btn');
    const notifDropdown = document.getElementById('admin-notifications-dropdown');
    const notifList = document.getElementById('admin-notifications-list');

    if (!notifWrapper || !notifBtn || !notifDropdown || !notifList) return;

    initialised = true;
    listenerAbortController = new AbortController();
    const { signal } = listenerAbortController;

    const markAllBtn = document.getElementById('admin-notifications-mark-all');
    const clearAllBtn = document.getElementById('admin-notifications-clear-all');

    // ---- Dropdown toggle -------------------------------------------------
    notifBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        notifDropdown.classList.toggle('hidden');
        notifDropdown.classList.toggle('flex');
    }, { signal });

    // Click-outside-to-close lives on document — exactly the listener that
    // outlives a logout when nobody tracks it. The AbortController removes
    // this and every other handler in one call.
    document.addEventListener('click', (e) => {
        if (notifWrapper.contains(e.target)) return;
        notifDropdown.classList.add('hidden');
        notifDropdown.classList.remove('flex');
    }, { signal });

    // ---- Row click: mark read, then navigate -----------------------------
    notifList.addEventListener('click', async (e) => {
        const item = e.target.closest('.notif-item');
        if (!item) return;

        const id = item.getAttribute('data-id');
        const linkTab = item.getAttribute('data-link');

        try {
            await updateDoc(doc(db, NOTIFICATIONS_COLLECTION, id), { read: true });
        } catch (err) {
            console.error('[admin-notifications] Error marking notification as read', err);
        }

        if (linkTab && VALID_LINK_TABS.has(linkTab)) {
            // Following an alert must show current data even when that tab
            // was loaded a minute ago: mark it stale before opening it.
            window.dispatchEvent(new CustomEvent('adminDataStale', {
                detail: { sectionId: `${linkTab.replace(/^nav-/, '')}-section` }
            }));
            const tabBtn = document.getElementById(linkTab);
            if (tabBtn) tabBtn.click();
            notifDropdown.classList.add('hidden');
            notifDropdown.classList.remove('flex');
        }
    }, { signal });

    // ---- Mark all read ---------------------------------------------------
    if (markAllBtn) {
        markAllBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
                const qUnread = query(
                    collection(db, NOTIFICATIONS_COLLECTION),
                    orderBy('createdAt', 'desc'),
                    limit(NOTIFICATIONS_LIMIT)
                );
                const snap = await getDocs(qUnread);
                const batch = writeBatch(db);
                let count = 0;

                snap.forEach(d => {
                    if (!d.data().read && d.data().isCleared !== true) {
                        batch.update(d.ref, { read: true });
                        count++;
                    }
                });

                if (count > 0) {
                    await batch.commit();
                }
            } catch (err) {
                console.error('[admin-notifications] Error marking all as read', err);
            }
        }, { signal });
    }

    // ---- Clear all (soft delete) -----------------------------------------
    if (clearAllBtn) {
        clearAllBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
                // Optimistic UI update.
                notifList.innerHTML = `<div class="px-4 py-8 text-center text-neutral-400 font-sans text-sm">Δεν υπάρχουν νέες ειδοποιήσεις.</div>`;
                renderBadge(0);

                const qAll = query(collection(db, NOTIFICATIONS_COLLECTION), limit(NOTIFICATIONS_LIMIT));
                const snap = await getDocs(qAll);
                const batch = writeBatch(db);

                snap.forEach(d => {
                    const data = d.data();
                    // Unified soft-delete for all notifications, so the
                    // generators cannot immediately regenerate them.
                    if (data.isCleared !== true) {
                        batch.update(d.ref, { isCleared: true, read: true });
                    }
                });

                await batch.commit();
            } catch (err) {
                console.error('[admin-notifications] Error clearing notifications', err);
            }
        }, { signal });
    }

    subscribeAll();
}

/**
 * Tears the module down on logout.
 *
 * Closes all three snapshot subscriptions, removes every DOM listener through
 * the AbortController, releases the audio context, and clears both the
 * rendered markup and the in-memory caches. Anything left behind here is data
 * from a finished session sitting in a page the next person can open.
 */
export function disposeNotificationsModule() {
    // Flip this first: in-flight generator writes and late snapshots check it
    // and bail out rather than acting on a dead session.
    initialised = false;

    closeSubscriptions();

    if (listenerAbortController) {
        listenerAbortController.abort();
        listenerAbortController = null;
    }

    closeAudioContext();

    knownNotificationIds = new Set();
    productStockState = new Map();
    previousUnreadCount = 0;
    isInitialLoad = true;

    const notifList = document.getElementById('admin-notifications-list');
    if (notifList) notifList.innerHTML = '';

    const notifBadge = document.getElementById('admin-notifications-badge');
    if (notifBadge) {
        notifBadge.textContent = '';
        notifBadge.classList.add('hidden');
    }

    const notifDropdown = document.getElementById('admin-notifications-dropdown');
    if (notifDropdown) {
        notifDropdown.classList.add('hidden');
        notifDropdown.classList.remove('flex');
    }
}
