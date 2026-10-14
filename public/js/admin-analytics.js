// public/js/admin-analytics.js
//
// Data Analytics tab: ROI dashboard, KPIs, charts, search logs, views per
// product.
//
// ---------------------------------------------------------------------------
// WHAT CHANGED IN PHASE 2, AND WHY
// ---------------------------------------------------------------------------
//
// 1. NO MORE SELF-INITIALISATION.
//    This file used to run at DOMContentLoaded from its own <script
//    type="module"> tag in admin.html — for anyone who opened the page,
//    signed in or not — and register a SECOND onAuthStateChanged listener to
//    do its own role check. That check did gate the data loads, so it was not
//    a data breach, but it meant: a duplicate auth subscription that was never
//    unsubscribed, nav listeners attached for unauthenticated visitors, and a
//    module living entirely outside the orchestrator's dependency-injection
//    gate while admin.js's header comment claimed no feature listener was
//    wired before the role was verified.
//    It now exports initAnalyticsModule(context), called by admin.js only
//    after the admin role is confirmed, exactly like the other feature
//    modules. It owns no auth logic at all.
//
// 2. EVERYTHING IS DISPOSABLE.
//    disposeAnalyticsModule() destroys the four Chart.js instances, removes
//    every listener in one shot via AbortController, clears the rendered DOM
//    and resets the load flag. Before this, logging out left the revenue
//    figures, the KPI numbers, the customers' search terms and four live
//    canvases sitting in the document, and hasLoadedOnce stayed true — so a
//    subsequent login showed the previous session's data and refused to
//    reload it.
//
// 3. THE ROI QUERY WAS UNBOUNDED.
//        query(collection(db, 'orders'), orderBy('createdAt', 'asc'))
//    Every order ever placed, downloaded into the browser, on one tab click.
//    At a few hundred orders that is invisible; at 50,000 it is a 50,000
//    document read charged to you, tens of megabytes of JSON, and a frozen
//    tab. It now pages in 1,000-document chunks up to a hard ceiling and says
//    so in the UI when the ceiling is reached. The all-time figures stay
//    exactly as they were for any catalogue under the ceiling.
//    product_views and search_logs are bounded the same way — a 30-day range
//    on a busy store is not a small collection either. Those take the NEWEST
//    documents and reverse, so truncation drops the oldest data rather than
//    the most recent.
//
// 4. documentId() 'in' QUERIES ARE CHUNKED.
//    Firestore caps an 'in' filter at 30 values. The call site passed the
//    top-10 list so it never tripped, but the limit lived nowhere in the code
//    and the next person to raise that 10 would have found out in production.
//
// DATA SOURCES
//   search_logs    (public/js/tracking.js)      -> term, termLower, timestamp
//   product_views  (public/js/tracking.js)      -> productId, timestamp
//   orders         (api/create-payment.js)      -> items[], totalAmount, status, createdAt
//   products       (existing collection)        -> title, for the views-per-product table

import { db } from './tenant-bridge.js';
import {
    collection, query, where, orderBy, limit, startAfter, getDocs, Timestamp, documentId
} from "https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js";
import { escapeHTML } from './sanitize.js';

// Must match the collection names exported by public/js/tracking.js.
const SEARCH_LOGS_COLLECTION = 'search_logs';
const PRODUCT_VIEWS_COLLECTION = 'product_views';
const ANALYTICS_BATCHES_COLLECTION = 'analytics_batches';
const ORDERS_COLLECTION = 'orders';

// Read ceilings. See note 3 above.
const ORDERS_PAGE_SIZE = 1000;
const ORDERS_MAX_PAGES = 10;          // 10,000 orders
const RANGE_QUERY_MAX_DOCS = 5000;    // per collection, per range
const FIRESTORE_IN_LIMIT = 30;        // hard platform limit on 'in' filters

const COMPLETED_ORDER_STATUSES = ['paid', 'shipped', 'confirmed'];

// Light Mode / minimalist palette.
const CHART_COLORS = {
    gridLine: 'rgba(0, 0, 0, 0.05)',
    tick: '#64748b',                   // slate-500
    line: '#1C1917',                   // stone-900 (Aura brand)
    lineFill: 'rgba(28, 25, 23, 0.03)',
    bar: '#d6d3d1',                    // stone-300
    barHover: '#a8a29e',               // stone-400
    tooltipBg: '#ffffff',
    tooltipTitle: '#1C1917',
    tooltipBody: '#57534E',
    tooltipBorder: '#e7e5e4',
    doughnutRamp: ['#1C1917', '#44403C', '#57534E', '#78716C', '#A8A29E', '#D6D3D1', '#E7E5E4', '#F5F5F4']
};

// ===========================================================================
// MODULE STATE
// ===========================================================================
//
// Held at module scope so dispose() can reach it. Every one of these is reset
// by disposeAnalyticsModule() — a value that survives a logout is a value the
// next person at the keyboard can read.

let initialised = false;
let listenerAbortController = null;
let hasLoadedOnce = false;
let currentPreset = '7d';

let viewsChart = null;
let wordsChart = null;
let ordersChart = null;
let roiChart = null;

// ===========================================================================
// PUBLIC API
// ===========================================================================

/**
 * Wires the analytics tab. Called by admin.js ONLY after the signed-in user's
 * admin role has been verified against Firestore.
 *
 * @param {{ currentUser: object, userData: object }} context
 */
export function initAnalyticsModule(context) {
    if (initialised) return;

    const analyticsSection = document.getElementById('analytics-section');
    if (!analyticsSection) return; // section not present on this page

    initialised = true;
    listenerAbortController = new AbortController();
    const { signal } = listenerAbortController;

    const presetSelect = document.getElementById('analytics-range-preset');
    const customRangeWrap = document.getElementById('analytics-custom-range');
    const applyRangeBtn = document.getElementById('analytics-apply-range-btn');

    currentPreset = presetSelect ? presetSelect.value : '7d';

    if (typeof Chart !== 'undefined') {
        Chart.defaults.color = CHART_COLORS.tick;
        Chart.defaults.font.family = "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif";
    }

    // Lazy load on first activation. admin.js owns tab switching and styling
    // for every tab including this one, and dispatches adminTabActivated — so
    // the duplicate hide-the-other-sections logic this module used to carry,
    // which fought admin.js's resetNavStyles for control of the same DOM, is
    // gone.
    window.addEventListener('adminTabActivated', (event) => {
        if (!event.detail || event.detail.sectionId !== 'analytics-section') return;
        if (hasLoadedOnce) return;

        hasLoadedOnce = true;
        loadROIDashboard();
        loadAnalytics();
    }, { signal });

    if (presetSelect) {
        presetSelect.addEventListener('change', () => {
            currentPreset = presetSelect.value;
            const isCustom = currentPreset === 'custom';
            if (customRangeWrap) {
                customRangeWrap.classList.toggle('hidden', !isCustom);
                customRangeWrap.classList.toggle('flex', isCustom);
            }
            if (!isCustom) loadAnalytics();
        }, { signal });
    }

    if (applyRangeBtn) {
        applyRangeBtn.addEventListener('click', () => loadAnalytics(), { signal });
    }
}

/**
 * Tears the module down on logout.
 *
 * One AbortController removes every listener registered above — no bookkeeping
 * of individual handler references, and nothing can be forgotten. Charts are
 * destroyed explicitly because Chart.js keeps its instances in a global
 * registry keyed by canvas; leaving them attached leaks the data and makes the
 * next init throw "Canvas is already in use".
 */
export function disposeAnalyticsModule() {
    if (listenerAbortController) {
        listenerAbortController.abort();
        listenerAbortController = null;
    }

    [viewsChart, wordsChart, ordersChart, roiChart].forEach((chart) => {
        if (chart && typeof chart.destroy === 'function') {
            try {
                chart.destroy();
            } catch (error) {
                console.warn('[admin-analytics] Chart destroy failed:', error);
            }
        }
    });

    viewsChart = null;
    wordsChart = null;
    ordersChart = null;
    roiChart = null;

    clearRenderedAnalytics();

    hasLoadedOnce = false;
    currentPreset = '7d';
    initialised = false;
}

/**
 * Removes every rendered figure from the document.
 *
 * Revenue, fees, conversion rates and the customers' raw search terms are all
 * on this tab. Hiding the section does not remove them from the DOM.
 */
function clearRenderedAnalytics() {
    ['stat-total-revenue', 'stat-viva-fees', 'stat-shopify-fees', 'stat-sqy-saved',
     'kpi-total-views', 'kpi-total-orders', 'kpi-conversion-rate']
        .forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.textContent = '—';
        });

    ['most-ordered-products-legend', 'recent-searches-list', 'views-per-product-body']
        .forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = '';
        });

    const rangeSummaryEl = document.getElementById('analytics-range-summary');
    if (rangeSummaryEl) rangeSummaryEl.textContent = '';

    ['analytics-loading-indicator', 'analytics-error-notice', 'analytics-empty-notice']
        .forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.classList.add('hidden');
        });
}

// ===========================================================================
// DATE RANGE RESOLUTION
// ===========================================================================

function startOfDay(d) {
    const copy = new Date(d);
    copy.setHours(0, 0, 0, 0);
    return copy;
}

function endOfDay(d) {
    const copy = new Date(d);
    copy.setHours(23, 59, 59, 999);
    return copy;
}

function resolveDateRange() {
    const now = new Date();
    const startDateInput = document.getElementById('analytics-start-date');
    const endDateInput = document.getElementById('analytics-end-date');

    if (currentPreset === '30d') {
        const start = startOfDay(now);
        start.setDate(start.getDate() - 29);
        return { start, end: endOfDay(now) };
    }

    if (currentPreset === 'month') {
        const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
        return { start, end: endOfDay(now) };
    }

    if (currentPreset === 'custom') {
        if (!startDateInput || !endDateInput || !startDateInput.value || !endDateInput.value) return null;
        const start = startOfDay(new Date(`${startDateInput.value}T00:00:00`));
        const end = endOfDay(new Date(`${endDateInput.value}T00:00:00`));
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return null;
        return { start, end };
    }

    // '7d' and any unknown value.
    const start = startOfDay(now);
    start.setDate(start.getDate() - 6);
    return { start, end: endOfDay(now) };
}

function formatRangeSummary(range) {
    const fmt = (d) => d.toLocaleDateString('el-GR', { day: '2-digit', month: 'short', year: 'numeric' });
    return `${fmt(range.start)} — ${fmt(range.end)}`;
}

// ===========================================================================
// FIRESTORE FETCHING (bounded)
// ===========================================================================

/**
 * Reads a timestamp-ranged collection, newest first, up to a hard ceiling,
 * then restores ascending order.
 *
 * Descending + limit is deliberate: if the range holds more documents than the
 * ceiling, the data that gets dropped is the OLDEST, not the most recent. An
 * ascending limit would silently show a stale window and look correct.
 */
async function fetchRangedDocs(collectionName, timestampField, start, end) {
    const rangeQuery = query(
        collection(db, collectionName),
        where(timestampField, '>=', Timestamp.fromDate(start)),
        where(timestampField, '<=', Timestamp.fromDate(end)),
        orderBy(timestampField, 'desc'),
        limit(RANGE_QUERY_MAX_DOCS)
    );

    const snapshot = await getDocs(rangeQuery);
    const docs = snapshot.docs.map(d => d.data());

    return {
        docs: docs.reverse(),
        truncated: snapshot.size >= RANGE_QUERY_MAX_DOCS
    };
}

// ---------------------------------------------------------------------------
// Batched analytics (tracking.js now writes ONE analytics_batches document per
// visit instead of one document per event). Batches are expanded back into
// the exact { productId, timestamp } / { term, termLower, timestamp } shapes
// the charts already consume, and merged with the legacy per-event
// collections so history recorded before the change still shows.
// ---------------------------------------------------------------------------

// Views and searches are requested together; this shares the single batch
// query between them (concurrent calls only — nothing is kept afterwards).
let batchesInFlight = { key: null, promise: null };

function fetchAnalyticsBatches(start, end) {
    const key = `${start.getTime()}_${end.getTime()}`;
    if (batchesInFlight.key !== key || !batchesInFlight.promise) {
        const promise = fetchRangedDocs(ANALYTICS_BATCHES_COLLECTION, 'timestamp', start, end)
            .finally(() => {
                if (batchesInFlight.promise === promise) batchesInFlight = { key: null, promise: null };
            });
        batchesInFlight = { key, promise };
    }
    return batchesInFlight.promise;
}

function toMillisSafe(value) {
    return value && typeof value.toMillis === 'function' ? value.toMillis() : 0;
}

// Event times are client clocks: keep them only when they are plausible
// (not after the server receipt, not more than 8 days before it).
function eventTimestamp(clientMs, batchMs) {
    const t = Number(clientMs);
    const plausible = Number.isFinite(t) && t <= batchMs && t > batchMs - 8 * 24 * 60 * 60 * 1000;
    return Timestamp.fromMillis(plausible ? t : batchMs);
}

function expandBatches(batchDocs, field, toEvent) {
    const events = [];
    batchDocs.forEach(batch => {
        const batchMs = toMillisSafe(batch.timestamp);
        if (!batchMs || !Array.isArray(batch[field])) return;
        batch[field].forEach(entry => {
            const event = entry && typeof entry === 'object' ? toEvent(entry, batchMs) : null;
            if (event) events.push(event);
        });
    });
    return events;
}

function mergeByTime(legacyDocs, batchedEvents) {
    return legacyDocs
        .concat(batchedEvents)
        .sort((a, b) => toMillisSafe(a.timestamp) - toMillisSafe(b.timestamp));
}

async function fetchProductViews(start, end) {
    const [legacy, batches] = await Promise.all([
        fetchRangedDocs(PRODUCT_VIEWS_COLLECTION, 'timestamp', start, end),
        fetchAnalyticsBatches(start, end)
    ]);
    const batched = expandBatches(batches.docs, 'views', (entry, batchMs) => (
        typeof entry.p === 'string' && entry.p
            ? { productId: entry.p, timestamp: eventTimestamp(entry.t, batchMs) }
            : null
    ));
    return {
        docs: mergeByTime(legacy.docs, batched),
        truncated: legacy.truncated || batches.truncated
    };
}

async function fetchSearchLogs(start, end) {
    const [legacy, batches] = await Promise.all([
        fetchRangedDocs(SEARCH_LOGS_COLLECTION, 'timestamp', start, end),
        fetchAnalyticsBatches(start, end)
    ]);
    const batched = expandBatches(batches.docs, 'searches', (entry, batchMs) => {
        const term = typeof entry.q === 'string' ? entry.q.trim().slice(0, 100) : '';
        return term
            ? { term, termLower: term.toLowerCase(), timestamp: eventTimestamp(entry.t, batchMs) }
            : null;
    });
    return {
        docs: mergeByTime(legacy.docs, batched),
        truncated: legacy.truncated || batches.truncated
    };
}

function fetchOrdersInRange(start, end) {
    return fetchRangedDocs(ORDERS_COLLECTION, 'createdAt', start, end);
}

/**
 * Pages through the orders collection for the all-time ROI figures.
 *
 * Replaces a single unbounded getDocs over every order ever placed. The
 * cursor-paged loop keeps peak memory at one page and stops at a ceiling
 * rather than at whatever the collection happens to hold.
 */
async function fetchAllOrdersBounded() {
    const orders = [];
    let cursor = null;
    let pages = 0;
    let truncated = false;

    while (pages < ORDERS_MAX_PAGES) {
        const pageQuery = cursor
            ? query(collection(db, ORDERS_COLLECTION), orderBy('createdAt', 'asc'), startAfter(cursor), limit(ORDERS_PAGE_SIZE))
            : query(collection(db, ORDERS_COLLECTION), orderBy('createdAt', 'asc'), limit(ORDERS_PAGE_SIZE));

        const snapshot = await getDocs(pageQuery);
        if (snapshot.empty) break;

        snapshot.forEach(docSnap => orders.push(docSnap.data()));
        cursor = snapshot.docs[snapshot.docs.length - 1];
        pages += 1;

        if (snapshot.size < ORDERS_PAGE_SIZE) break;
        if (pages >= ORDERS_MAX_PAGES) truncated = true;
    }

    return { orders, truncated };
}

/**
 * Resolves product titles by id, chunked to Firestore's 'in' ceiling.
 */
async function fetchProductTitles(productIds) {
    const uniqueIds = Array.from(new Set(productIds)).filter(Boolean);
    const titleMap = new Map();
    if (uniqueIds.length === 0) return titleMap;

    const chunks = [];
    for (let i = 0; i < uniqueIds.length; i += FIRESTORE_IN_LIMIT) {
        chunks.push(uniqueIds.slice(i, i + FIRESTORE_IN_LIMIT));
    }

    try {
        await Promise.all(chunks.map(async (chunk) => {
            const chunkQuery = query(collection(db, 'products'), where(documentId(), 'in', chunk));
            const snapshot = await getDocs(chunkQuery);
            snapshot.forEach(docSnap => {
                titleMap.set(docSnap.id, docSnap.data().title || 'Unknown Product');
            });
        }));
    } catch (error) {
        console.error('[admin-analytics] Failed to resolve product titles:', error);
    }

    return titleMap;
}

// ===========================================================================
// ROI DASHBOARD (all-time, bounded)
// ===========================================================================

async function loadROIDashboard() {
    const statTotalRevenue = document.getElementById('stat-total-revenue');
    const statVivaFees = document.getElementById('stat-viva-fees');
    const statShopifyFees = document.getElementById('stat-shopify-fees');
    const statSqySaved = document.getElementById('stat-sqy-saved');

    try {
        const { orders, truncated } = await fetchAllOrdersBounded();

        let totalRevenue = 0;
        let totalOrders = 0;

        // key = "YYYY-MM" -> { revenue, orders, date }
        const monthlyData = new Map();

        orders.forEach(data => {
            // Only count successfully completed orders.
            if (!COMPLETED_ORDER_STATUSES.includes(data.status)) return;

            const amount = Number(data.totalAmount) || 0;
            totalRevenue += amount;
            totalOrders += 1;

            if (data.createdAt && typeof data.createdAt.toDate === 'function') {
                const date = data.createdAt.toDate();
                const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

                if (!monthlyData.has(monthKey)) {
                    monthlyData.set(monthKey, { revenue: 0, orders: 0, date });
                }

                const monthStats = monthlyData.get(monthKey);
                monthStats.revenue += amount;
                monthStats.orders += 1;
            }
        });

        const activeMonths = Math.max(1, monthlyData.size);

        const totalVivaFees = (totalRevenue * 0.015) + (totalOrders * 0.20);

        // Shopify: Viva fees + 2% penalty + (39€ base + 90€ apps) per month.
        const totalShopifyFees = totalVivaFees + (totalRevenue * 0.02) + (activeMonths * 129);

        // SQy Systems: Viva fees + 39€ base per month.
        // Saved is strictly the difference: (2% * revenue) + (90€ * months).
        const totalSaved = (totalRevenue * 0.02) + (activeMonths * 90);

        const formatCurrency = (val) =>
            `€${val.toLocaleString('el-GR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

        if (statTotalRevenue) statTotalRevenue.textContent = formatCurrency(totalRevenue);
        if (statVivaFees) statVivaFees.textContent = formatCurrency(totalVivaFees);
        if (statShopifyFees) statShopifyFees.textContent = formatCurrency(totalShopifyFees);
        if (statSqySaved) statSqySaved.textContent = formatCurrency(totalSaved);

        if (truncated) {
            // Never let a capped read masquerade as an all-time total.
            console.warn(`[admin-analytics] ROI figures capped at ${ORDERS_MAX_PAGES * ORDERS_PAGE_SIZE} orders.`);
            if (statTotalRevenue) {
                statTotalRevenue.title =
                    `Υπολογισμός βάσει των πρώτων ${ORDERS_MAX_PAGES * ORDERS_PAGE_SIZE} παραγγελιών.`;
            }
        }

        const sortedMonths = Array.from(monthlyData.keys()).sort();
        const labels = [];
        const shopifyData = [];
        const sqyData = [];

        sortedMonths.forEach(key => {
            const stats = monthlyData.get(key);
            labels.push(stats.date.toLocaleDateString('el-GR', { month: 'short', year: 'numeric' }));
            shopifyData.push((stats.revenue * 0.02) + 129); // 2% + 39€ base + 90€ apps
            sqyData.push(39);                               // 39€ base, apps included, 0% penalty
        });

        renderROIChart(labels, shopifyData, sqyData);

    } catch (error) {
        console.error('[admin-analytics] Error loading ROI dashboard:', error);
    }
}

function renderROIChart(labels, shopifyData, sqyData) {
    const roiSavingsCanvas = document.getElementById('roi-savings-chart');
    if (!roiSavingsCanvas || typeof Chart === 'undefined') return;

    if (roiChart) roiChart.destroy();

    roiChart = new Chart(roiSavingsCanvas, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'Shopify (Προμήθεια 2% + Πάγιο 129€)',
                    data: shopifyData,
                    borderColor: '#ef4444',
                    backgroundColor: 'rgba(239, 68, 68, 0.05)',
                    fill: true,
                    tension: 0.4,
                    borderWidth: 2,
                    pointRadius: 4,
                    pointBackgroundColor: '#ef4444'
                },
                {
                    label: 'SQy Systems (Πάγιο 39€ - Όλα ενσωματωμένα)',
                    data: sqyData,
                    borderColor: '#10b981',
                    backgroundColor: 'rgba(16, 185, 129, 0.05)',
                    fill: true,
                    tension: 0.4,
                    borderWidth: 2,
                    pointRadius: 4,
                    pointBackgroundColor: '#10b981'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: {
                    position: 'top',
                    labels: {
                        font: { family: "'Plus Jakarta Sans', sans-serif" },
                        color: CHART_COLORS.tick,
                        usePointStyle: true,
                        boxWidth: 8
                    }
                },
                tooltip: {
                    backgroundColor: CHART_COLORS.tooltipBg,
                    titleColor: CHART_COLORS.tooltipTitle,
                    bodyColor: CHART_COLORS.tooltipBody,
                    borderColor: CHART_COLORS.tooltipBorder,
                    borderWidth: 1,
                    padding: 12,
                    titleFont: { family: "'Plus Jakarta Sans', sans-serif", size: 13 },
                    bodyFont: { family: "'Plus Jakarta Sans', sans-serif", size: 13 },
                    callbacks: {
                        label(context) {
                            let label = context.dataset.label || '';
                            if (label) label += ': ';
                            if (context.parsed.y !== null) {
                                label += new Intl.NumberFormat('el-GR', { style: 'currency', currency: 'EUR' })
                                    .format(context.parsed.y);
                            }
                            return label;
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { color: CHART_COLORS.tick, font: { family: "'Plus Jakarta Sans', sans-serif" } }
                },
                y: {
                    beginAtZero: true,
                    grid: { color: CHART_COLORS.gridLine },
                    ticks: {
                        color: CHART_COLORS.tick,
                        font: { family: "'Plus Jakarta Sans', sans-serif" },
                        callback: (value) => `€${value}`
                    }
                }
            }
        }
    });
}

// ===========================================================================
// AGGREGATION
// ===========================================================================

function dayKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dayLabel(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('el-GR', { day: '2-digit', month: 'short' });
}

function groupViewsByDay(viewDocs, start, end) {
    const buckets = new Map();
    const cursor = startOfDay(start);
    const lastDay = startOfDay(end);

    while (cursor <= lastDay) {
        buckets.set(dayKey(cursor), 0);
        cursor.setDate(cursor.getDate() + 1);
    }

    viewDocs.forEach(v => {
        if (!v.timestamp || typeof v.timestamp.toDate !== 'function') return;
        const key = dayKey(v.timestamp.toDate());
        if (buckets.has(key)) buckets.set(key, buckets.get(key) + 1);
    });

    return buckets;
}

function aggregateTopWords(searchDocs, max = 10) {
    const counts = new Map();
    searchDocs.forEach(s => {
        const key = (s.termLower || String(s.term || '').toLowerCase()).trim();
        if (!key) return;
        counts.set(key, (counts.get(key) || 0) + 1);
    });
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, max);
}

function getRecentSearches(searchDocs, max = 15) {
    return searchDocs
        .filter(s => s.timestamp && typeof s.timestamp.toDate === 'function')
        .slice()
        .sort((a, b) => b.timestamp.toMillis() - a.timestamp.toMillis())
        .slice(0, max);
}

function aggregateOrderedProducts(orderDocs, max = 8) {
    const counts = new Map();
    orderDocs.forEach(o => {
        if (!COMPLETED_ORDER_STATUSES.includes(o.status)) return;
        (o.items || []).forEach(item => {
            if (!item || !item.id) return;
            const existing = counts.get(item.id) || { title: item.title || item.id, quantity: 0 };
            existing.quantity += Number(item.quantity) || 0;
            counts.set(item.id, existing);
        });
    });
    return Array.from(counts.entries())
        .map(([id, v]) => ({ id, title: v.title, quantity: v.quantity }))
        .sort((a, b) => b.quantity - a.quantity)
        .slice(0, max);
}

function computeKpis(viewDocs, orderDocs) {
    const totalViews = viewDocs.length;
    const totalOrders = orderDocs.filter(o => COMPLETED_ORDER_STATUSES.includes(o.status)).length;
    const conversionRate = totalViews > 0 ? (totalOrders / totalViews) * 100 : 0;
    return { totalViews, totalOrders, conversionRate };
}

function aggregateViewsByProduct(viewDocs, max = 10) {
    const counts = new Map();
    viewDocs.forEach(v => {
        if (!v.productId) return;
        counts.set(v.productId, (counts.get(v.productId) || 0) + 1);
    });
    return Array.from(counts.entries())
        .map(([id, count]) => ({ id, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, max);
}

// ===========================================================================
// RENDERING
// ===========================================================================

function renderKpis({ totalViews, totalOrders, conversionRate }) {
    const kpiTotalViewsEl = document.getElementById('kpi-total-views');
    const kpiTotalOrdersEl = document.getElementById('kpi-total-orders');
    const kpiConversionRateEl = document.getElementById('kpi-conversion-rate');

    if (kpiTotalViewsEl) kpiTotalViewsEl.textContent = totalViews.toLocaleString('el-GR');
    if (kpiTotalOrdersEl) kpiTotalOrdersEl.textContent = totalOrders.toLocaleString('el-GR');
    if (kpiConversionRateEl) kpiConversionRateEl.textContent = `${conversionRate.toFixed(1)}%`;
}

function renderViewsChart(dayBuckets) {
    const viewsCanvas = document.getElementById('views-over-time-chart');
    if (!viewsCanvas || typeof Chart === 'undefined') return;

    const labels = Array.from(dayBuckets.keys()).map(dayLabel);
    const data = Array.from(dayBuckets.values());

    if (viewsChart) viewsChart.destroy();
    viewsChart = new Chart(viewsCanvas, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: 'Προβολές',
                data,
                borderColor: CHART_COLORS.line,
                backgroundColor: CHART_COLORS.lineFill,
                fill: true,
                tension: 0.35,
                borderWidth: 2,
                pointRadius: 3,
                pointBackgroundColor: CHART_COLORS.line,
                pointBorderColor: '#ffffff'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: CHART_COLORS.tooltipBg,
                    titleColor: CHART_COLORS.tooltipTitle,
                    bodyColor: CHART_COLORS.tooltipBody,
                    borderColor: CHART_COLORS.tooltipBorder,
                    borderWidth: 1,
                    padding: 10
                }
            },
            scales: {
                x: {
                    grid: { color: CHART_COLORS.gridLine },
                    ticks: { color: CHART_COLORS.tick, maxRotation: 0, autoSkip: true }
                },
                y: {
                    beginAtZero: true,
                    grid: { color: CHART_COLORS.gridLine },
                    ticks: { color: CHART_COLORS.tick, precision: 0 }
                }
            }
        }
    });
}

function renderWordsChart(topWords) {
    const wordsCanvas = document.getElementById('top-searched-words-chart');
    if (!wordsCanvas || typeof Chart === 'undefined') return;

    const labels = topWords.map(([term]) => term);
    const data = topWords.map(([, count]) => count);

    if (wordsChart) wordsChart.destroy();
    wordsChart = new Chart(wordsCanvas, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: 'Αναζητήσεις',
                data,
                backgroundColor: CHART_COLORS.bar,
                hoverBackgroundColor: CHART_COLORS.barHover,
                borderRadius: 4,
                maxBarThickness: 22
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: CHART_COLORS.tooltipBg,
                    titleColor: CHART_COLORS.tooltipTitle,
                    bodyColor: CHART_COLORS.tooltipBody,
                    borderColor: CHART_COLORS.tooltipBorder,
                    borderWidth: 1,
                    padding: 10
                }
            },
            scales: {
                x: {
                    beginAtZero: true,
                    grid: { color: CHART_COLORS.gridLine },
                    ticks: { color: CHART_COLORS.tick, precision: 0 }
                },
                y: {
                    grid: { display: false },
                    ticks: { color: CHART_COLORS.tick }
                }
            }
        }
    });
}

function renderOrdersChart(topProducts) {
    const ordersCanvas = document.getElementById('most-ordered-products-chart');
    if (!ordersCanvas || typeof Chart === 'undefined') return;

    const labels = topProducts.map(p => p.title);
    const data = topProducts.map(p => p.quantity);
    const colors = labels.map((_, i) => CHART_COLORS.doughnutRamp[i % CHART_COLORS.doughnutRamp.length]);

    if (ordersChart) ordersChart.destroy();
    ordersChart = new Chart(ordersCanvas, {
        type: 'doughnut',
        data: {
            labels,
            datasets: [{ data, backgroundColor: colors, borderColor: '#ffffff', borderWidth: 2 }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '65%',
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: CHART_COLORS.tooltipBg,
                    titleColor: CHART_COLORS.tooltipTitle,
                    bodyColor: CHART_COLORS.tooltipBody,
                    borderColor: CHART_COLORS.tooltipBorder,
                    borderWidth: 1,
                    padding: 10
                }
            }
        }
    });

    renderOrdersLegend(topProducts, colors);
}

function renderOrdersLegend(topProducts, colors) {
    const ordersLegendEl = document.getElementById('most-ordered-products-legend');
    if (!ordersLegendEl) return;

    if (topProducts.length === 0) {
        ordersLegendEl.innerHTML = `<li class="text-neutral-500">Δεν υπάρχουν παραγγελίες για αυτή την περίοδο.</li>`;
        return;
    }

    // colors[] comes from the module's own constant ramp, never from data.
    ordersLegendEl.innerHTML = topProducts.map((p, i) => `
        <li class="flex items-center justify-between gap-3">
            <span class="flex items-center gap-2 truncate">
                <span class="w-2.5 h-2.5 rounded-full flex-shrink-0" style="background-color: ${escapeHTML(colors[i])};"></span>
                <span class="truncate text-neutral-600">${escapeHTML(p.title)}</span>
            </span>
            <span class="text-neutral-500 font-medium flex-shrink-0">${escapeHTML(p.quantity.toLocaleString('el-GR'))}</span>
        </li>
    `).join('');
}

function renderRecentSearches(searchDocs) {
    const recentSearchesEl = document.getElementById('recent-searches-list');
    if (!recentSearchesEl) return;

    const recent = getRecentSearches(searchDocs, 15);

    if (recent.length === 0) {
        recentSearchesEl.innerHTML = `<li class="px-1 py-6 text-center text-neutral-500 text-sm">Δεν υπάρχουν αναζητήσεις για αυτή την περίοδο.</li>`;
        return;
    }

    // s.term is raw visitor input from the storefront search box — the single
    // most attacker-reachable string on this tab.
    recentSearchesEl.innerHTML = recent.map(s => {
        const timeStr = s.timestamp.toDate()
            .toLocaleString('el-GR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        return `
            <li class="flex items-center justify-between py-3 border-b border-gray-100 last:border-0">
                <span class="font-sans text-sm text-neutral-700 truncate pr-4">${escapeHTML(s.term || '')}</span>
                <span class="font-sans text-[11px] text-neutral-400 whitespace-nowrap">${escapeHTML(timeStr)}</span>
            </li>
        `;
    }).join('');
}

async function renderViewsPerProductTable(viewDocs) {
    const viewsPerProductBody = document.getElementById('views-per-product-body');
    if (!viewsPerProductBody) return;

    const ranked = aggregateViewsByProduct(viewDocs, 10);

    if (ranked.length === 0) {
        viewsPerProductBody.innerHTML = `<tr><td colspan="3" class="py-6 text-center text-neutral-500 text-sm">Δεν υπάρχουν προβολές για αυτή την περίοδο.</td></tr>`;
        return;
    }

    const titleMap = await fetchProductTitles(ranked.map(r => r.id));
    const maxCount = ranked[0].count || 1;

    viewsPerProductBody.innerHTML = ranked.map((item, index) => {
        const title = titleMap.get(item.id) || 'Unknown Product';
        const barWidth = Math.max(4, Math.round((item.count / maxCount) * 100));
        return `
            <tr class="border-b border-gray-100 last:border-0">
                <td class="py-3 pr-4 align-middle font-sans text-xs text-neutral-500">${index + 1}</td>
                <td class="py-3 pr-4 align-middle">
                    <div class="font-sans text-sm text-neutral-800 truncate max-w-[260px] mb-1.5">${escapeHTML(title)}</div>
                    <div class="h-1 w-full max-w-[220px] bg-gray-100 rounded-full overflow-hidden">
                        <div class="h-full bg-neutral-900 rounded-full" style="width: ${barWidth}%;"></div>
                    </div>
                </td>
                <td class="py-3 pl-4 align-middle text-right font-sans text-sm text-neutral-900 font-medium whitespace-nowrap">${escapeHTML(item.count.toLocaleString('el-GR'))}</td>
            </tr>
        `;
    }).join('');
}

// ===========================================================================
// UI STATE + MAIN LOAD FLOW
// ===========================================================================

function setLoading(isLoading) {
    const el = document.getElementById('analytics-loading-indicator');
    if (el) el.classList.toggle('hidden', !isLoading);
}

function setError(hasError) {
    const el = document.getElementById('analytics-error-notice');
    if (el) el.classList.toggle('hidden', !hasError);
}

function setEmpty(isEmpty) {
    const el = document.getElementById('analytics-empty-notice');
    if (el) el.classList.toggle('hidden', !isEmpty);
}

async function loadAnalytics() {
    // The module is only initialised for a verified admin, so reaching this
    // point already implies authorisation. The guard is against a stale
    // callback firing after dispose().
    if (!initialised) return;

    const range = resolveDateRange();
    if (!range) return;

    const rangeSummaryEl = document.getElementById('analytics-range-summary');
    if (rangeSummaryEl) rangeSummaryEl.textContent = formatRangeSummary(range);

    setError(false);
    setEmpty(false);
    setLoading(true);

    try {
        const [views, searches, orders] = await Promise.all([
            fetchProductViews(range.start, range.end),
            fetchSearchLogs(range.start, range.end),
            fetchOrdersInRange(range.start, range.end)
        ]);

        // A dispose() between the fetch starting and resolving must not repaint
        // a logged-out dashboard with the previous session's data.
        if (!initialised) return;

        const viewDocs = views.docs;
        const searchDocs = searches.docs;
        const orderDocs = orders.docs;

        renderViewsChart(groupViewsByDay(viewDocs, range.start, range.end));
        renderWordsChart(aggregateTopWords(searchDocs, 10));
        renderRecentSearches(searchDocs);
        renderOrdersChart(aggregateOrderedProducts(orderDocs, 8));
        renderKpis(computeKpis(viewDocs, orderDocs));

        await renderViewsPerProductTable(viewDocs);

        if (views.truncated || searches.truncated || orders.truncated) {
            console.warn(`[admin-analytics] Range capped at ${RANGE_QUERY_MAX_DOCS} documents per collection; figures show the most recent data in the period.`);
            if (rangeSummaryEl) {
                rangeSummaryEl.textContent =
                    `${formatRangeSummary(range)} (μερική προβολή — τα πιο πρόσφατα ${RANGE_QUERY_MAX_DOCS} δεδομένα)`;
            }
        }

        if (viewDocs.length === 0 && searchDocs.length === 0 && orderDocs.length === 0) {
            setEmpty(true);
        }
    } catch (error) {
        console.error('[admin-analytics] Failed to load analytics:', error);
        setError(true);
    } finally {
        setLoading(false);
    }
}
