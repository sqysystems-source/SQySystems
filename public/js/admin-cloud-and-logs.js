import { buildStoreApiUrl } from './tenant-bridge.js';
// public/js/admin-cloud-and-logs.js
//
// Three cohesive concerns that share the storage-quota surface:
//   * Cloud Drive  - usage calculation, R2 presigned upload via XHR, direct
//                    download, deletion
//   * Customers    - directory listing
//   * Support      - ticket listing + resolution/deletion
//   * Audit Logs   - cursor pagination, category filter, search, metadata modal
//
// MODULE-SCOPE EXPORTS (deliberate): getStorageUsage, adjustStorageUsage,
// and updateStorageUIOnly live at module scope rather than inside the init
// closure, because admin-products.js must adjust the quota when a product
// image is uploaded or deleted. Exporting a mutator instead of the raw
// variable keeps the state owned here and the dependency one-directional
// (products -> cloud). This module imports nothing from products.

import { db, logAdminAction, formatBytes, showCloudDriveAlert, hideCloudDriveAlert,
         MAX_STORAGE_BYTES, MAX_SINGLE_FILE_BYTES, getCurrentUser } from './admin-utils.js';
import { collection, getDocs, addDoc, doc, deleteDoc, query, orderBy,
         serverTimestamp, limit, startAfter, writeBatch, documentId } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js";
import { escapeHTML } from './sanitize.js';

// Customers, Support and Cloud Drive used to be read IN FULL on every
// dashboard load (all three tabs start hidden) and again on every tab click.
// Each now loads on first open and is reused on re-open for this long.
const ADMIN_TAB_MAX_AGE_MS = 5 * 60 * 1000;
// Customers were one unbounded read of the whole users collection.
const CUSTOMERS_PAGE_SIZE = 100;

// ==========================================
// STORAGE QUOTA STATE (module scope - see note above)
// ==========================================
const cloudDriveDropzone = document.getElementById('cloud-drive-dropzone');
const cloudDriveFileInput = document.getElementById('cloud-drive-file-input');
const cloudDriveAlert = document.getElementById('cloud-drive-alert');
const cloudDriveFileList = document.getElementById('cloud-drive-file-list');

const storageProgressImages = document.getElementById('storage-progress-images');
const storageProgressDrive = document.getElementById('storage-progress-drive');
const legendImagesText = document.getElementById('legend-images-text');
const legendDriveText = document.getElementById('legend-drive-text');
const legendFreeText = document.getElementById('legend-free-text');
const storageUsedLabel = document.getElementById('storage-used-label');
const storageTotalLabel = document.getElementById('storage-total-label');
const storagePercentLabel = document.getElementById('storage-percent-label');

const uploadProgressContainer = document.getElementById('upload-progress-container');
const uploadFileNameLabel = document.getElementById('upload-file-name');
const uploadPercentLabel = document.getElementById('upload-percent-label');
const uploadProgressBar = document.getElementById('upload-progress-bar');
const uploadStatusLabel = document.getElementById('upload-status-label');

const cloudDriveSection = document.getElementById('cloud-drive-section');
const LOGS_PER_PAGE = 25;
const R2_PUBLIC_BASE_URL = '';
let isUploading = false;

// How many files the drive list pulls before the product-image rows are
// filtered out. The old code took the newest 100 documents and *then* removed
// product images, so a burst of 100 product uploads made a drive full of files
// render as empty. Over-fetch, filter, then cap.
const CLOUD_DRIVE_FETCH_LIMIT = 300;
const CLOUD_DRIVE_DISPLAY_LIMIT = 100;

// Audit-log deletion pages through the collection instead of reading it whole:
// a mature admin_logs collection is tens of thousands of documents, and the
// single unbounded getDocs() it replaces was both a memory spike and a large
// billed read.
const LOG_DELETE_PAGE_SIZE = 400;

// Client-side upload allowlist. This is convenience and damage-limitation, NOT
// a control: the presign endpoint must repeat every one of these checks (and
// enforce the byte count on the signed PUT), because nothing stops a caller
// from hitting /api/r2 directly. What it does buy: the Cloud Drive input used
// to accept *any* file, so an .html or .svg dropped in here becomes a live
// same-origin document the moment the bucket is served publicly — stored XSS
// against whoever opens the link.
const ALLOWED_DRIVE_EXTENSIONS = new Set([
    'jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp', 'tiff',
    'mp4', 'webm', 'mov', 'm4v',
    'mp3', 'wav', 'ogg',
    'pdf', 'txt', 'csv', 'json', 'md', 'rtf',
    'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
    'zip'
]);

// Explicitly refused even if an extension somehow slips past: anything the
// browser will parse as a document or execute.
const BLOCKED_DRIVE_EXTENSIONS = new Set([
    'html', 'htm', 'xhtml', 'shtml', 'svg', 'xml', 'js', 'mjs', 'cjs',
    'php', 'phtml', 'jsp', 'asp', 'aspx', 'exe', 'dll', 'bat', 'cmd',
    'com', 'scr', 'sh', 'bash', 'ps1', 'jar', 'msi', 'apk', 'hta', 'wsf', 'vbs'
]);

function getFileExtension(fileName) {
    const base = String(fileName || '').split(/[\\/]/).pop();
    const dotIndex = base.lastIndexOf('.');
    return dotIndex > 0 ? base.slice(dotIndex + 1).toLowerCase() : '';
}

let currentImagesUsage = 0;
let currentDriveUsage = 0;
let currentStorageUsage = 0;

export function getStorageUsage() {
    return currentStorageUsage;
}

/**
 * Adjust the in-memory quota by a signed delta and repaint the meter.
 * Imported by admin-products.js on product-image upload/delete.
 */
export function adjustStorageUsage(deltaBytes, type = 'images') {
    if (type === 'images') {
        currentImagesUsage = Math.max(0, currentImagesUsage + (Number(deltaBytes) || 0));
    } else {
        currentDriveUsage = Math.max(0, currentDriveUsage + (Number(deltaBytes) || 0));
    }
    currentStorageUsage = currentImagesUsage + currentDriveUsage;
    updateStorageUIOnly();
    return currentStorageUsage;
}

// The Logs nav handler in admin.js calls fetchAdminLogs(true) when the tab is
// opened. The implementation closes over init-scoped state (lastLogDoc,
// currentLogs, the filter inputs), so rather than hoisting it and dragging that
// state to module scope, a thin public wrapper delegates to the instance bound
// during init. No-ops safely if called before initialisation.
let _fetchAdminLogs = null;

export function fetchAdminLogs(reset = false) {
    if (typeof _fetchAdminLogs === 'function') return _fetchAdminLogs(reset);
    console.warn('[admin-cloud-and-logs] fetchAdminLogs called before module init.');
}

// Logout hook. The init closure holds the fetched audit entries and the
// pagination cursor; hiding the dashboard does not drop them, so the
// orchestrator calls this to make the previous session's data unreachable
// from the page.
let _resetModuleState = null;

export function resetCloudAndLogsState() {
    currentImagesUsage = 0;
    currentDriveUsage = 0;
    currentStorageUsage = 0;
    updateStorageUIOnly();
    if (typeof _resetModuleState === 'function') _resetModuleState();
}

export function updateStorageUIOnly() {
    if (!storageProgressImages || !storageProgressDrive) return;

    const usedImages = Math.max(0, currentImagesUsage);
    const usedDrive = Math.max(0, currentDriveUsage);
    const usedTotal = Math.min(usedImages + usedDrive, MAX_STORAGE_BYTES);
    
    const percentImages = MAX_STORAGE_BYTES > 0 ? (usedImages / MAX_STORAGE_BYTES) * 100 : 0;
    const percentDrive = MAX_STORAGE_BYTES > 0 ? (usedDrive / MAX_STORAGE_BYTES) * 100 : 0;
    const freeBytes = Math.max(0, MAX_STORAGE_BYTES - usedTotal);
    const percentFree = Math.max(0, 100 - percentImages - percentDrive);
    const percentTotal = Math.min(100, percentImages + percentDrive);

    storageProgressImages.style.width = `${percentImages}%`;
    storageProgressDrive.style.width = `${percentDrive}%`;

    if (storageUsedLabel) storageUsedLabel.textContent = formatBytes(usedTotal);
    if (storageTotalLabel) storageTotalLabel.textContent = formatBytes(MAX_STORAGE_BYTES);
    if (storagePercentLabel) storagePercentLabel.textContent = `${percentTotal.toFixed(1)}%`;

    if (legendImagesText) legendImagesText.textContent = `Εικόνες Προϊόντων: ${formatBytes(usedImages)} (${percentImages.toFixed(1)}%)`;
    if (legendDriveText) legendDriveText.textContent = `Αρχεία Drive: ${formatBytes(usedDrive)} (${percentDrive.toFixed(1)}%)`;
    if (legendFreeText) legendFreeText.textContent = `Ελεύθερος Χώρος: ${formatBytes(freeBytes)} (${percentFree.toFixed(1)}%)`;
}

/**
 * Wires Cloud Drive, Customers, Support and Audit Logs, then loads each.
 * @param {{ currentUser: import('firebase/auth').User, userData: object }} context
 */
export function initCloudAndLogsModule(context) {
    const customersTableBody = document.getElementById('customers-table-body');

    // Support Elements
    const supportTableBody = document.getElementById('support-table-body');

    const logsTableBody = document.getElementById('logs-table-body');
    const logsCategoryFilter = document.getElementById('logs-category-filter');
    const logsSearchInput = document.getElementById('logs-search-input');
    const refreshLogsBtn = document.getElementById('refresh-logs-btn');
    const clearLogsBtn = document.getElementById('clear-logs-btn');
    const loadMoreLogsBtn = document.getElementById('load-more-logs-btn');
    const logMetadataModal = document.getElementById('log-metadata-modal');
    const logMetadataBackdrop = document.getElementById('log-metadata-backdrop');
    const closeLogMetadataBtn = document.getElementById('close-log-metadata-btn');
    const logMetadataContent = document.getElementById('log-metadata-content');
    
    let lastLogDoc = null;
    let currentLogs = [];

    // Load timestamps for the lazily loaded tabs (0 = never loaded).
    let customersLoadedAt = 0;
    let supportLoadedAt = 0;
    let supportStale = false;
    let cloudDriveLoadedAt = 0;

    function isTabDataFresh(loadedAt) {
        return loadedAt > 0 && Date.now() - loadedAt < ADMIN_TAB_MAX_AGE_MS;
    }

    // 6. CUSTOMERS DIRECTORY
    // ==========================================
    // Paged by document id — the order the old unbounded getDocs() returned —
    // with a "load more" control created under the table.
    let customersCursor = null;
    let isFetchingCustomers = false;
    const customersMoreWrap = document.createElement('div');
    customersMoreWrap.className = 'hidden justify-center mt-6';
    customersMoreWrap.innerHTML = '<button type="button" class="font-sans text-xs tracking-widest uppercase border border-gray-300 text-neutral-600 px-8 py-3 hover:bg-neutral-50 transition-colors rounded-sm">Φόρτωση περισσότερων πελατών</button>';
    const customersMoreBtn = customersMoreWrap.querySelector('button');
    const customersTableContainer = customersTableBody ? customersTableBody.closest('.overflow-x-auto') : null;
    if (customersTableContainer) customersTableContainer.insertAdjacentElement('afterend', customersMoreWrap);

    function customerRowHTML(user) {
        const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Μη διαθέσιμο';
        const postalCode = user.postalCode || user.zip || '';
        const fullAddress = `${user.address || ''}, ${postalCode}`.replace(/^, | , $/g, '').trim();
        const displayAddress = fullAddress && fullAddress !== ',' ? fullAddress : 'Μη διαθέσιμο';

        return `
            <tr class="hover:bg-neutral-50 transition-colors border-b border-gray-100">
                <td class="p-4 font-medium text-neutral-900">${escapeHTML(fullName)}</td>
                <td class="p-4 text-neutral-500">${escapeHTML(user.email || 'N/A')}</td>
                <td class="p-4 text-neutral-500">${escapeHTML(user.phone || 'N/A')}</td>
                <td class="p-4 text-neutral-500">${escapeHTML(displayAddress)}</td>
            </tr>
        `;
    }

    async function fetchCustomers({ append = false } = {}) {
        if (isFetchingCustomers) return;
        isFetchingCustomers = true;
        customersMoreBtn.disabled = true;

        if (!append) {
            customersCursor = null;
            customersTableBody.innerHTML = `<tr><td colspan="4" class="p-8 text-center text-neutral-400">Φόρτωση πελατών...</td></tr>`;
        }

        try {
            const constraints = [orderBy(documentId())];
            if (append && customersCursor) constraints.push(startAfter(customersCursor));
            constraints.push(limit(CUSTOMERS_PAGE_SIZE));
            const querySnapshot = await getDocs(query(collection(db, "users"), ...constraints));

            const users = [];
            querySnapshot.forEach((docSnap) => {
                users.push(docSnap.data());
            });

            if (querySnapshot.docs.length) customersCursor = querySnapshot.docs[querySnapshot.docs.length - 1];
            const hasMore = querySnapshot.docs.length === CUSTOMERS_PAGE_SIZE;
            customersMoreWrap.classList.toggle('hidden', !hasMore);
            customersMoreWrap.classList.toggle('flex', hasMore);

            if (!append) customersLoadedAt = Date.now();

            if (!append && users.length === 0) {
                customersTableBody.innerHTML = `<tr><td colspan="4" class="p-8 text-center text-neutral-400">Δεν βρέθηκαν πελάτες.</td></tr>`;
                return;
            }

            const rowsHTML = users.map(customerRowHTML).join('');
            if (append) {
                customersTableBody.insertAdjacentHTML('beforeend', rowsHTML);
            } else {
                customersTableBody.innerHTML = rowsHTML;
            }
        } catch (error) {
            console.error("Error fetching customers:", error);
            if (!append) {
                customersTableBody.innerHTML = `<tr><td colspan="4" class="p-8 text-center text-red-500">Σφάλμα φόρτωσης.</td></tr>`;
            }
        } finally {
            isFetchingCustomers = false;
            customersMoreBtn.disabled = false;
        }
    }

    customersMoreBtn.addEventListener('click', () => fetchCustomers({ append: true }));

    // ==========================================

    // 7. SUPPORT TICKETS MANAGEMENT
    // ==========================================
    async function fetchSupportTickets() {
        supportTableBody.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-neutral-400">Φόρτωση αιτημάτων...</td></tr>`;
        try {
            const querySnapshot = await getDocs(collection(db, "support_tickets"));
            let tickets = [];
            
            querySnapshot.forEach((docSnap) => {
                tickets.push({ id: docSnap.id, ...docSnap.data() });
            });

            // Tickets are client-written: never assume a real Timestamp.
            const ticketMillis = (ticket) => (ticket.timestamp && typeof ticket.timestamp.toMillis === 'function')
                ? ticket.timestamp.toMillis()
                : 0;
            tickets.sort((a, b) => ticketMillis(b) - ticketMillis(a));
            supportLoadedAt = Date.now();
            supportStale = false;

            if (tickets.length === 0) {
                supportTableBody.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-neutral-400">Δεν βρέθηκαν αιτήματα.</td></tr>`;
                return;
            }

            supportTableBody.innerHTML = tickets.map(ticket => {
                const badgeHtml = ticket.isRegistered 
                    ? `<span class="px-2 py-1 bg-green-100 text-green-800 rounded text-[10px] uppercase font-bold tracking-wider">Εγγεγραμμένος</span>`
                    : `<span class="px-2 py-1 bg-gray-200 text-gray-700 rounded text-[10px] uppercase font-bold tracking-wider">Επισκέπτης</span>`;

                const dateObj = ticket.timestamp && typeof ticket.timestamp.toDate === 'function'
                    ? ticket.timestamp.toDate()
                    : new Date(0);
                const dateStr = dateObj.toLocaleDateString('el-GR', { month: 'short', day: 'numeric', year: 'numeric' });

                return `
                    <tr class="hover:bg-neutral-50 transition-colors align-top border-b border-gray-100">
                        <td class="p-4">
                            <div class="flex flex-col gap-1">
                                <span class="font-medium text-neutral-900">${escapeHTML(ticket.senderName || 'N/A')}</span>
                                <span class="text-neutral-500 text-xs">${escapeHTML(ticket.senderEmail || 'N/A')}</span>
                                <span class="text-neutral-500 text-xs">${escapeHTML(ticket.senderPhone || 'N/A')}</span>
                                <span class="text-neutral-400 text-xs mt-1 max-w-[200px] truncate" title="${escapeHTML(ticket.senderAddress || '')}">${escapeHTML(ticket.senderAddress || 'N/A')}</span>
                            </div>
                        </td>
                        <td class="p-4">
                            <div class="flex flex-col gap-1">
                                <span class="text-neutral-900 font-medium">${escapeHTML(ticket.issueType || 'Γενική Ερώτηση')}</span>
                                <span class="text-neutral-400 text-xs">${escapeHTML(dateStr)}</span>
                            </div>
                        </td>
                        <td class="p-4">
                            <div class="text-neutral-600 text-sm max-w-sm whitespace-pre-wrap">${escapeHTML(ticket.message || 'Χωρίς μήνυμα.')}</div>
                        </td>
                        <td class="p-4">
                            ${badgeHtml}
                        </td>
                        <td class="p-4 text-right">
                            <button class="delete-ticket-btn text-red-400 hover:text-red-700 transition-colors underline underline-offset-4 text-xs tracking-widest uppercase" data-id="${escapeHTML(ticket.id)}">
                                Επίλυση (Διαγραφή)
                            </button>
                        </td>
                    </tr>
                `;
            }).join('');
            
        } catch (error) {
            console.error("Error fetching support tickets:", error);
            supportTableBody.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-red-500">Σφάλμα φόρτωσης.</td></tr>`;
        }
    }

    // admin-notifications.js reports NEW_TICKET notifications as they arrive,
    // and marks the target tab stale when an alert is clicked.
    window.addEventListener('adminDataStale', (e) => {
        const sectionId = e.detail && e.detail.sectionId;
        if (sectionId === 'support-section') supportStale = true;
        if (sectionId === 'customers-section') customersLoadedAt = 0;
        if (sectionId === 'cloud-drive-section') cloudDriveLoadedAt = 0;
    });

    supportTableBody.addEventListener('click', async (e) => {
        if (e.target.classList.contains('delete-ticket-btn')) {
            const ticketId = e.target.getAttribute('data-id');
            if (confirm("Είστε σίγουροι ότι θέλετε να επισημάνετε αυτό το αίτημα ως επιλυμένο; Αυτό θα διαγράψει μόνιμα την εγγραφή.")) {
                try {
                    await deleteDoc(doc(db, "support_tickets", ticketId));
                    await logAdminAction('DELETE', 'system', `Επίλυση/Διαγραφή αιτήματος υποστήριξης.`, { ticketId });
                    // Known exactly: drop the row locally (was: re-read every ticket).
                    e.target.closest('tr')?.remove();
                    if (!supportTableBody.querySelector('.delete-ticket-btn')) {
                        supportTableBody.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-neutral-400">Δεν βρέθηκαν αιτήματα.</td></tr>`;
                    }
                } catch (error) {
                    console.error("Error deleting ticket:", error);
                    alert("Σφάλμα διαγραφής.");
                }
            }
        }
    });

    // ==========================================

    // 8. CLOUD DRIVE (Cloudflare R2 direct upload)
    // ==========================================
    //
    // Storage accounting model:
    //   - calculateCurrentStorageUsage() hits /api/r2?action=storage-usage, which
    //     lists both R2 buckets directly — the actual physical byte count
    //     Cloudflare bills, independent of whatever Firestore says. This is
    //     the ground truth, but it's a paginated ListObjectsV2 call under the
    //     hood (a billed Class A request per 1,000 objects), so it is NOT
    //     called after every click.
    //   - renderStorageMeter() calls that ground truth and is reserved for
    //     initial load (initCloudDrive()), where paying for one authoritative
    //     read to establish a correct baseline is worth it.
    //   - Every individual upload/delete instead adjusts the in-memory
    //     currentStorageUsage directly by the known delta and calls the
    //     lightweight updateStorageUIOnly() — no network round trip, no R2
    //     listing cost. This can drift from the R2 ground truth within a
    //     single session (e.g. two admin tabs open at once), but it
    //     self-corrects the next time renderStorageMeter() runs — on the next
    //     full page load or Cloud Drive tab visit — so the drift is bounded,
    //     not permanent the way a manually-maintained Firestore counter was.
    async function calculateCurrentStorageUsage() {
        if (!getCurrentUser()) return 0;
        try {
            const res = await fetch(buildStoreApiUrl('/api/r2?action=storage-usage'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${await getCurrentUser().getIdToken()}`
                }
            });
            if (!res.ok) throw new Error('Failed to fetch physical storage');
            const data = await res.json();
            
            currentImagesUsage = Number(data.productImagesBytes) || 0;
            currentDriveUsage = Number(data.cloudDriveBytes) || 0;
            currentStorageUsage = currentImagesUsage + currentDriveUsage;
            
            return currentStorageUsage;
        } catch (error) {
            console.error('[cloud-drive] Failed to calculate storage usage:', error);
            // Keep showing the last known value on failure rather than
            // resetting the meter to 0.
            return currentStorageUsage;
        }
    }

    // The "heavy" path: fetches the R2 ground truth, then delegates to the
    // lightweight DOM updater. Reserved for initial load — see the comment
    // above this section.
    async function renderStorageMeter() {
        await calculateCurrentStorageUsage();
        updateStorageUIOnly();
    }

    function buildUniqueFileName(originalName) {
        const base = String(originalName || 'file').split(/[\\/]/).pop().trim();
        const dotIndex = base.lastIndexOf('.');

        let stem = dotIndex > 0 ? base.slice(0, dotIndex) : base;
        let extension = dotIndex > 0 ? base.slice(dotIndex + 1) : '';

        stem = stem.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_{2,}/g, '_').replace(/^[._-]+/, '').replace(/[._-]+$/, '').slice(0, 80);
        extension = extension.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10).toLowerCase();

        if (!stem) stem = 'file';

        const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        return extension ? `${stem}_${uniqueSuffix}.${extension}` : `${stem}_${uniqueSuffix}`;
    }

    function setUploadProgress(percent, statusText) {
        if (uploadProgressBar) uploadProgressBar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
        if (uploadPercentLabel) uploadPercentLabel.textContent = `${Math.round(percent)}%`;
        if (statusText && uploadStatusLabel) uploadStatusLabel.textContent = statusText;
    }

    function showUploadPanel(fileName) {
        if (!uploadProgressContainer) return;
        if (uploadFileNameLabel) uploadFileNameLabel.textContent = fileName;
        setUploadProgress(0, 'Προετοιμασία μεταφόρτωσης...');
        uploadProgressContainer.classList.remove('hidden');
    }

    function hideUploadPanel() {
        if (uploadProgressContainer) uploadProgressContainer.classList.add('hidden');
    }

    function uploadToR2(uploadUrl, file, contentType) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('PUT', uploadUrl, true);
            xhr.setRequestHeader('Content-Type', contentType);

            xhr.upload.addEventListener('progress', (event) => {
                if (event.lengthComputable) {
                    const percent = (event.loaded / event.total) * 100;
                    setUploadProgress(percent, `Μεταφόρτωση... ${formatBytes(event.loaded)} από ${formatBytes(event.total)}`);
                }
            });

            xhr.addEventListener('load', () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve();
                } else if (xhr.status === 403) {
                    reject(new Error('Η υπογραφή απορρίφθηκε από τον διακομιστή αποθήκευσης. Δοκιμάστε ξανά.'));
                } else {
                    reject(new Error(`Η μεταφόρτωση απέτυχε (κωδικός ${xhr.status}).`));
                }
            });

            xhr.addEventListener('error', () => reject(new Error('Σφάλμα δικτύου κατά τη μεταφόρτωση.')));
            xhr.addEventListener('abort', () => reject(new Error('Η μεταφόρτωση ακυρώθηκε.')));

            xhr.send(file);
        });
    }

    async function fetchCloudDriveFiles() {
        if (!cloudDriveFileList || !getCurrentUser()) return;

        try {
            const filesRef = collection(db, 'users', getCurrentUser().uid, 'cloud_drive_files');
            const filesQuery = query(filesRef, orderBy('uploadedAt', 'desc'), limit(CLOUD_DRIVE_FETCH_LIMIT));
            const snapshot = await getDocs(filesQuery);

            const files = [];
            snapshot.forEach((docSnap) => files.push({ id: docSnap.id, ...docSnap.data() }));
            cloudDriveLoadedAt = Date.now();

            renderCloudDriveFiles(
                files.filter(f => f.type !== 'product_image').slice(0, CLOUD_DRIVE_DISPLAY_LIMIT)
            );
        } catch (error) {
            console.error('[cloud-drive] Error fetching files:', error);
            cloudDriveFileList.innerHTML = `<li class="px-6 py-8 text-center text-red-500 font-sans text-sm">Σφάλμα φόρτωσης αρχείων.</li>`;
        }
    }

    function renderCloudDriveFiles(files) {
        if (!cloudDriveFileList) return;

        if (!files.length) {
            cloudDriveFileList.innerHTML = `<li class="px-6 py-10 text-center text-neutral-400 font-sans text-sm">Δεν έχετε ανεβάσει ακόμη αρχεία.</li>`;
            return;
        }

        cloudDriveFileList.innerHTML = files.map((file) => {
            const uploadedDate = file.uploadedAt && typeof file.uploadedAt.toDate === 'function'
                ? file.uploadedAt.toDate().toLocaleDateString('el-GR', { day: '2-digit', month: 'short', year: 'numeric' })
                : '—';

            const downloadButton = `<button class="download-cloud-file-btn text-neutral-400 hover:text-neutral-900 transition-colors underline underline-offset-4 text-[10px] tracking-widest uppercase"
                    data-key="${escapeHTML(file.fileKey || '')}" data-name="${escapeHTML(file.originalName || '')}">Λήψη</button>`;

            const displaySize = typeof file.fileSize === 'number' ? file.fileSize : (typeof file.size === 'number' ? file.size : 0);

            return `
                <li class="px-6 py-4 flex items-center justify-between gap-4 hover:bg-neutral-50 transition-colors">
                    <div class="min-w-0">
                        <p class="font-sans text-sm text-neutral-900 truncate">${escapeHTML(file.originalName || file.fileKey || 'Χωρίς όνομα')}</p>
                        <p class="font-sans text-xs text-neutral-400 mt-1">${escapeHTML(formatBytes(displaySize))} &middot; ${escapeHTML(uploadedDate)}</p>
                    </div>
                    <div class="flex items-center gap-4 flex-shrink-0">
                        ${downloadButton}
                        <button class="delete-cloud-file-btn text-red-400 hover:text-red-700 transition-colors underline underline-offset-4 text-[10px] tracking-widest uppercase"
                                data-id="${escapeHTML(file.id)}" data-key="${escapeHTML(file.fileKey || '')}" data-size="${escapeHTML(String(displaySize))}">Διαγραφή</button>
                    </div>
                </li>
            `;
        }).join('');
    }

    async function handleFileSelected(file) {
        if (!file || isUploading) return;

        hideCloudDriveAlert();

        if (!getCurrentUser()) {
            showCloudDriveAlert('Η συνεδρία σας έληξε. Συνδεθείτε ξανά.');
            return;
        }

        if (file.size > MAX_SINGLE_FILE_BYTES) {
            showCloudDriveAlert(`Το αρχείο είναι πολύ μεγάλο. Το μέγιστο μέγεθος ανά αρχείο είναι ${formatBytes(MAX_SINGLE_FILE_BYTES)}.`);
            return;
        }

        if (!Number.isFinite(file.size) || file.size <= 0) {
            showCloudDriveAlert('Το αρχείο είναι κενό και δεν μπορεί να μεταφορτωθεί.');
            return;
        }

        const extension = getFileExtension(file.name);
        if (!extension || BLOCKED_DRIVE_EXTENSIONS.has(extension) || !ALLOWED_DRIVE_EXTENSIONS.has(extension)) {
            showCloudDriveAlert('Μη υποστηριζόμενος τύπος αρχείου. Εκτελέσιμα αρχεία και αρχεία HTML/SVG/XML δεν επιτρέπονται.');
            return;
        }

        // The in-memory counter is a session-local estimate that only
        // re-synchronises with the R2 ground truth on a full Cloud Drive
        // load, so it under-reports whenever a second tab (or another admin)
        // has uploaded since. Re-read the authoritative number before letting
        // an upload near the ceiling through — one billed listing is cheaper
        // than silently blowing the quota.
        if (file.size + currentStorageUsage > MAX_STORAGE_BYTES * 0.9) {
            await calculateCurrentStorageUsage();
            updateStorageUIOnly();
        }

        if (file.size + currentStorageUsage > MAX_STORAGE_BYTES) {
            showCloudDriveAlert(`Το όριο αποθηκευτικού χώρου (${formatBytes(MAX_STORAGE_BYTES)}) ξεπεράστηκε. Αναβαθμίστε το πακέτο σας.`);
            return;
        }

        isUploading = true;
        if (cloudDriveDropzone) cloudDriveDropzone.classList.add('opacity-50', 'pointer-events-none');
        showUploadPanel(file.name);

        const uniqueFileName = buildUniqueFileName(file.name);

        try {
            setUploadProgress(0, 'Δημιουργία ασφαλούς συνδέσμου...');
            const idToken = await getCurrentUser().getIdToken();

            const presignResponse = await fetch(buildStoreApiUrl('/api/r2?action=upload-url'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${idToken}`
                },
                body: JSON.stringify({
                    fileName: uniqueFileName,
                    fileType: file.type || 'application/octet-stream',
                    fileSize: file.size,
                    tenantId: getCurrentUser().uid
                })
            });

            let presignData;
            try {
                presignData = await presignResponse.json();
            } catch (parseError) {
                throw new Error('Μη έγκυρη απάντηση από τον διακομιστή.');
            }

            if (!presignResponse.ok) {
                throw new Error(presignData?.error || 'Δεν ήταν δυνατή η προετοιμασία της μεταφόρτωσης.');
            }

            setUploadProgress(0, 'Έναρξη μεταφόρτωσης...');
            await uploadToR2(presignData.uploadUrl, file, presignData.contentType);

            setUploadProgress(100, 'Ολοκλήρωση...');

            const fileUrl = R2_PUBLIC_BASE_URL
                ? `${R2_PUBLIC_BASE_URL.replace(/\/+$/, '')}/${presignData.fileKey}`
                : '';

            await addDoc(collection(db, 'users', getCurrentUser().uid, 'cloud_drive_files'), {
                originalName: file.name,
                fileKey: presignData.fileKey,
                url: fileUrl,
                fileSize: file.size,
                contentType: presignData.contentType,
                uploadedAt: serverTimestamp()
            });

            currentDriveUsage += file.size;
            currentStorageUsage = currentImagesUsage + currentDriveUsage;
            updateStorageUIOnly();
            await fetchCloudDriveFiles();

            hideUploadPanel();
            showCloudDriveAlert(`Το αρχείο "${file.name}" μεταφορτώθηκε με επιτυχία.`, 'success');
            await logAdminAction('CREATE', 'cloud_drive', `Μεταφόρτωση αρχείου: ${file.name}`, { size: file.size, type: file.type });

        } catch (error) {
            console.error('[cloud-drive] Upload failed:', error);
            hideUploadPanel();
            showCloudDriveAlert(error.message || 'Η μεταφόρτωση απέτυχε. Δοκιμάστε ξανά.');
        } finally {
            isUploading = false;
            if (cloudDriveDropzone) cloudDriveDropzone.classList.remove('opacity-50', 'pointer-events-none');
            if (cloudDriveFileInput) cloudDriveFileInput.value = '';
        }
    }

    async function initCloudDrive(userData) {
        if (!cloudDriveSection) return;

        // The meter is one server-side aggregate (no client document reads)
        // and stays on dashboard load. The file list (up to
        // CLOUD_DRIVE_FETCH_LIMIT document reads) now loads when the Cloud
        // Drive tab is first opened.
        await renderStorageMeter();
    }

    if (cloudDriveDropzone && cloudDriveFileInput) {
        cloudDriveDropzone.addEventListener('click', () => {
            if (!isUploading) cloudDriveFileInput.click();
        });

        cloudDriveFileInput.addEventListener('change', (e) => {
            const file = e.target.files && e.target.files[0];
            if (file) handleFileSelected(file);
        });

        ['dragenter', 'dragover'].forEach((eventName) => {
            cloudDriveDropzone.addEventListener(eventName, (e) => {
                e.preventDefault();
                e.stopPropagation();
                cloudDriveDropzone.classList.add('border-neutral-900', 'bg-neutral-50');
            });
        });

        ['dragleave', 'drop'].forEach((eventName) => {
            cloudDriveDropzone.addEventListener(eventName, (e) => {
                e.preventDefault();
                e.stopPropagation();
                cloudDriveDropzone.classList.remove('border-neutral-900', 'bg-neutral-50');
            });
        });

        cloudDriveDropzone.addEventListener('drop', (e) => {
            const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
            if (file) handleFileSelected(file);
        });
    }

    function triggerBrowserDownload(url, suggestedName) {
        // The href comes back from /api/r2. Treat it as untrusted anyway: an
        // anchor is clicked programmatically here, and a javascript: or data:
        // href would execute in the admin origin if the endpoint were ever
        // compromised or confused into echoing a caller-supplied value.
        let parsedUrl;
        try {
            parsedUrl = new URL(url, window.location.origin);
        } catch (_error) {
            showCloudDriveAlert('Ο σύνδεσμος λήψης δεν είναι έγκυρος.');
            return;
        }
        if (!['https:', 'http:'].includes(parsedUrl.protocol)) {
            showCloudDriveAlert('Ο σύνδεσμος λήψης απορρίφθηκε για λόγους ασφαλείας.');
            return;
        }

        const link = document.createElement('a');
        link.href = parsedUrl.href;
        link.rel = 'noopener';
        if (suggestedName) link.download = suggestedName;
        document.body.appendChild(link);
        link.click();
        link.remove();
    }

    if (cloudDriveFileList) {
        cloudDriveFileList.addEventListener('click', async (e) => {
            const downloadBtn = e.target.closest('.download-cloud-file-btn');
            if (downloadBtn && getCurrentUser()) {
                const fileKey = downloadBtn.getAttribute('data-key');
                const fileName = downloadBtn.getAttribute('data-name') || '';

                if (!fileKey) {
                    showCloudDriveAlert('Το αρχείο δεν είναι διαθέσιμο για λήψη.');
                    return;
                }

                const originalText = downloadBtn.textContent;
                downloadBtn.disabled = true;
                downloadBtn.textContent = '...';
                hideCloudDriveAlert();

                try {
                    const idToken = await getCurrentUser().getIdToken();

                    const response = await fetch(buildStoreApiUrl('/api/r2?action=download-url'), {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${idToken}`
                        },
                        body: JSON.stringify({
                            fileKey,
                            tenantId: getCurrentUser().uid
                        })
                    });

                    let data;
                    try {
                        data = await response.json();
                    } catch (parseError) {
                        throw new Error('Μη έγκυρη απάντηση από τον διακομιστή.');
                    }

                    if (!response.ok) {
                        throw new Error(data?.error || 'Δεν ήταν δυνατή η λήψη του αρχείου.');
                    }

                    triggerBrowserDownload(data.downloadUrl, data.fileName || fileName);
                    await logAdminAction('EXPORT', 'cloud_drive', `Λήψη αρχείου: ${fileName}`, { fileKey });

                } catch (error) {
                    console.error('[cloud-drive] Download failed:', error);
                    showCloudDriveAlert(error.message || 'Η λήψη απέτυχε. Δοκιμάστε ξανά.');
                } finally {
                    downloadBtn.disabled = false;
                    downloadBtn.textContent = originalText;
                }
                return;
            }

            const deleteBtn = e.target.closest('.delete-cloud-file-btn');
            if (!deleteBtn || !getCurrentUser()) return;

            const fileId = deleteBtn.getAttribute('data-id');
            const fileKey = deleteBtn.getAttribute('data-key');
            const fileSize = Number(deleteBtn.getAttribute('data-size')) || 0;

            if (!confirm('Είστε σίγουροι ότι θέλετε να διαγράψετε αυτό το αρχείο;')) return;

            deleteBtn.disabled = true;
            deleteBtn.textContent = '...';

            try {
                const idToken = await getCurrentUser().getIdToken();
                const response = await fetch(buildStoreApiUrl('/api/r2?action=delete-file'), {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${idToken}`
                    },
                    body: JSON.stringify({ fileKey, fileId, fileSize })
                });

                const data = await response.json();
                if (!response.ok) {
                    throw new Error(data.error || 'Σφάλμα κατά τη διαγραφή του αρχείου.');
                }

                const freedBytes = Number(data.freedBytes) || fileSize || 0;
                currentDriveUsage = Math.max(0, currentDriveUsage - freedBytes);
                currentStorageUsage = currentImagesUsage + currentDriveUsage;
                updateStorageUIOnly();
                
                await fetchCloudDriveFiles();
                showCloudDriveAlert('Η εγγραφή του αρχείου διαγράφηκε.', 'info');
                await logAdminAction('DELETE', 'cloud_drive', `Διαγραφή αρχείου.`, { fileId, size: fileSize });
            } catch (error) {
                console.error('[cloud-drive] Delete failed:', error);
                deleteBtn.disabled = false;
                deleteBtn.textContent = 'Διαγραφή';
                showCloudDriveAlert(error.message || 'Σφάλμα κατά τη διαγραφή του αρχείου.');
            }
        });
    }

    // ==========================================

    // 9. AUDIT LOGS VIEW
    // ==========================================
    async function fetchAdminLogs(reset = false) {
        if (!logsTableBody) return;
        
        if (reset) {
            lastLogDoc = null;
            currentLogs = [];
            logsTableBody.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-neutral-400">Φόρτωση αρχείου καταγραφής...</td></tr>`;
            if (loadMoreLogsBtn) loadMoreLogsBtn.classList.add('hidden');
        }

        try {
            let q;
            if (lastLogDoc) {
                q = query(collection(db, "admin_logs"), orderBy("timestamp", "desc"), startAfter(lastLogDoc), limit(LOGS_PER_PAGE));
            } else {
                q = query(collection(db, "admin_logs"), orderBy("timestamp", "desc"), limit(LOGS_PER_PAGE));
            }

            const snapshot = await getDocs(q);
            
            if (!snapshot.empty) {
                lastLogDoc = snapshot.docs[snapshot.docs.length - 1];
            }

            const newLogs = [];
            snapshot.forEach(docSnap => {
                newLogs.push({ id: docSnap.id, ...docSnap.data() });
            });

            currentLogs = reset ? newLogs : [...currentLogs, ...newLogs];
            renderAdminLogs();

            if (snapshot.docs.length < LOGS_PER_PAGE) {
                if (loadMoreLogsBtn) loadMoreLogsBtn.classList.add('hidden');
            } else {
                if (loadMoreLogsBtn) loadMoreLogsBtn.classList.remove('hidden');
            }

        } catch (error) {
            console.error("Error fetching admin logs:", error);
            logsTableBody.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-red-500">Σφάλμα φόρτωσης.</td></tr>`;
        }
    }

    function renderAdminLogs() {
        const categoryFilter = logsCategoryFilter.value;
        const searchTerm = logsSearchInput.value.trim().toLowerCase();

        const filteredLogs = currentLogs.filter(log => {
            const matchCategory = categoryFilter === 'all' || log.category === categoryFilter;
            const matchSearch = !searchTerm || (log.description && log.description.toLowerCase().includes(searchTerm));
            return matchCategory && matchSearch;
        });

        if (filteredLogs.length === 0) {
            logsTableBody.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-neutral-400">Δεν υπάρχουν καταγεγραμμένες ενέργειες.</td></tr>`;
            return;
        }

        const categoryBadges = {
            products: 'bg-indigo-50 text-indigo-700 border-indigo-200',
            orders: 'bg-emerald-50 text-emerald-700 border-emerald-200',
            cloud_drive: 'bg-sky-50 text-sky-700 border-sky-200',
            system: 'bg-stone-100 text-stone-700 border-stone-300'
        };

        const categoryLabels = {
            products: 'Προϊόντα',
            orders: 'Παραγγελίες',
            cloud_drive: 'Cloud Drive',
            system: 'Σύστημα'
        };

        logsTableBody.innerHTML = filteredLogs.map(log => {
            const dateObj = log.timestamp ? log.timestamp.toDate() : new Date();
            const dateStr = dateObj.toLocaleDateString('el-GR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute:'2-digit' });
            
            const badgeClass = categoryBadges[log.category] || categoryBadges.system;
            const badgeLabel = categoryLabels[log.category] || 'Άγνωστο';

            // The metadata JSON used to be interpolated into a data- attribute.
            // JSON is made of double quotes, so that markup was one
            // escapeHTML() implementation detail away from attribute-injection
            // XSS — and admin_logs metadata carries attacker-influenced values
            // (file names, ticket ids). Carry the log id instead and read the
            // object back out of memory on click.

            return `
                <tr class="hover:bg-neutral-50 transition-colors border-b border-gray-100 align-top">
                    <td class="p-4 text-xs text-neutral-500 whitespace-nowrap">${escapeHTML(dateStr)}</td>
                    <td class="p-4 text-xs text-neutral-600 truncate max-w-[150px]" title="${escapeHTML(log.adminEmail || 'N/A')}">${escapeHTML(log.adminEmail || 'N/A')}</td>
                    <td class="p-4">
                        <span class="px-2 py-1 border rounded text-[10px] uppercase font-bold tracking-wider ${badgeClass}">${badgeLabel}</span>
                    </td>
                    <td class="p-4 text-sm text-neutral-900">${escapeHTML(log.description || '')}</td>
                    <td class="p-4 text-right">
                        <button class="view-log-meta-btn text-[10px] uppercase tracking-widest text-blue-600 hover:text-blue-800 transition-colors underline underline-offset-4" data-log-id="${escapeHTML(log.id)}">Προβολή JSON</button>
                    </td>
                </tr>
            `;
        }).join('');
    }

    if (refreshLogsBtn) {
        refreshLogsBtn.addEventListener('click', () => fetchAdminLogs(true));
    }

    if (clearLogsBtn) {
        clearLogsBtn.addEventListener('click', async () => {
            if (!confirm('Είστε σίγουροι ότι θέλετε να διαγράψετε οριστικά όλο το ιστορικό καταγραφών;')) return;

            const originalText = clearLogsBtn.innerHTML;
            clearLogsBtn.innerHTML = 'Διαγραφή...';
            clearLogsBtn.disabled = true;

            let deleted = 0;
            try {
                // Page through the collection instead of reading it whole.
                // Each page is one batch, well under the hard 500-write limit,
                // and a failure half-way leaves a partially cleared trail that
                // the operator is told about rather than a silent stall.
                for (;;) {
                    const pageQuery = query(
                        collection(db, "admin_logs"),
                        orderBy("timestamp", "desc"),
                        limit(LOG_DELETE_PAGE_SIZE)
                    );
                    const snapshot = await getDocs(pageQuery);
                    if (snapshot.empty) break;

                    const batch = writeBatch(db);
                    snapshot.forEach((docSnap) => batch.delete(docSnap.ref));
                    await batch.commit();

                    deleted += snapshot.size;
                    clearLogsBtn.innerHTML = `Διαγραφή... (${deleted})`;

                    if (snapshot.size < LOG_DELETE_PAGE_SIZE) break;
                }

                lastLogDoc = null;
                currentLogs = [];
                renderAdminLogs();
                if (loadMoreLogsBtn) loadMoreLogsBtn.classList.add('hidden');
                
                alert(`Το ιστορικό καταγραφών διαγράφηκε επιτυχώς (${deleted} εγγραφές).`);
            } catch (error) {
                console.error("Error clearing admin logs:", error);
                alert(`Σφάλμα κατά την εκκαθάριση των καταγραφών. Διαγράφηκαν ${deleted} εγγραφές πριν τη διακοπή.`);
                await fetchAdminLogs(true);
            } finally {
                clearLogsBtn.innerHTML = originalText;
                clearLogsBtn.disabled = false;
            }
        });
    }

    if (loadMoreLogsBtn) {
        loadMoreLogsBtn.addEventListener('click', () => fetchAdminLogs(false));
    }

    if (logsCategoryFilter) {
        logsCategoryFilter.addEventListener('change', renderAdminLogs);
    }

    if (logsSearchInput) {
        logsSearchInput.addEventListener('input', renderAdminLogs);
    }

    if (logsTableBody) {
        logsTableBody.addEventListener('click', (e) => {
            if (e.target.classList.contains('view-log-meta-btn')) {
                const logId = e.target.getAttribute('data-log-id');
                const entry = currentLogs.find(item => item.id === logId);
                // textContent, never innerHTML: the metadata is arbitrary
                // operator- and customer-supplied data.
                logMetadataContent.textContent = entry && entry.metadata
                    ? JSON.stringify(entry.metadata, null, 2)
                    : '{}';
                logMetadataModal.classList.remove('hidden');
            }
        });
    }

    if (closeLogMetadataBtn && logMetadataBackdrop) {
        const closeMetaModal = () => logMetadataModal.classList.add('hidden');
        closeLogMetadataBtn.addEventListener('click', closeMetaModal);
        logMetadataBackdrop.addEventListener('click', closeMetaModal);
    }


    // Expose the logs fetcher to the orchestrator's nav handler.
    _fetchAdminLogs = fetchAdminLogs;

    // Expose the state reset to the orchestrator's logout path.
    _resetModuleState = () => {
        lastLogDoc = null;
        currentLogs = [];
        // The tables below are emptied, so nothing on screen is "fresh" now.
        customersLoadedAt = 0;
        supportLoadedAt = 0;
        cloudDriveLoadedAt = 0;
        customersCursor = null;
        customersMoreWrap.classList.add('hidden');
        customersMoreWrap.classList.remove('flex');
        if (logsTableBody) logsTableBody.innerHTML = '';
        if (customersTableBody) customersTableBody.innerHTML = '';
        if (supportTableBody) supportTableBody.innerHTML = '';
        if (cloudDriveFileList) cloudDriveFileList.innerHTML = '';
        if (logMetadataContent) logMetadataContent.textContent = '';
        if (loadMoreLogsBtn) loadMoreLogsBtn.classList.add('hidden');
        hideCloudDriveAlert();
    };

    window.addEventListener('adminTabActivated', (e) => {
        // Defence in depth: the orchestrator gates navigation, but this
        // listener lives on window and any script on the page can dispatch
        // the event. No verified user, no fetch.
        if (!getCurrentUser()) return;
        // First open loads; a re-open inside ADMIN_TAB_MAX_AGE_MS reuses what
        // is on screen (support also re-reads when a new ticket was reported).
        if (e.detail.sectionId === 'customers-section') {
            if (!isTabDataFresh(customersLoadedAt)) fetchCustomers();
        } else if (e.detail.sectionId === 'support-section') {
            if (supportStale || !isTabDataFresh(supportLoadedAt)) fetchSupportTickets();
        } else if (e.detail.sectionId === 'logs-section') {
            // The single Logs fetch (admin.js no longer calls it a second time).
            fetchAdminLogs(true);
        } else if (e.detail.sectionId === 'cloud-drive-section') {
            if (!isTabDataFresh(cloudDriveLoadedAt)) fetchCloudDriveFiles();
        }
    });

    // Initial loads (called directly from onAuthStateChanged in the monolith).
    // Customers and Support are NOT read here any more: both tabs start
    // hidden and load on first open.
    initCloudDrive(context && context.userData ? context.userData : {});
}
