// public/js/admin.js
//
// ORCHESTRATOR & SHELL.
//
// Owns: navigation, verified-session feature initialisation, logout, and
// module initialisation. Owns NO feature logic — orders, products, cloud
// drive, customers, support and audit logs all live in their own modules.
//
// DEPENDENCY INJECTION: feature modules never import auth state. This file
// delegates managed tenant authentication and role checks to tenant-bridge, pushes the verified
// user into admin-utils via setCurrentUser(), then calls each module's
// init*(context). No feature listener is wired until that point, so a
// non-admin session can never reach feature code.
//
// Import graph (acyclic, verified):
//   admin.js -> admin-orders.js         -> admin-utils.js
//            -> admin-products.js       -> admin-cloud-and-logs.js -> admin-utils.js
//            -> admin-cloud-and-logs.js -> admin-utils.js
//            -> admin-settings.js       -> admin-utils.js

import { startTenantBridge, logoutPortal } from './tenant-bridge.js';
import { disposeCategoryTree } from './category-store.js';
import { disposeCatalogSnapshot } from './catalog-snapshot.js';
import { setCurrentUser, getCurrentUser, logAdminAction } from './admin-utils.js';
import { initOrdersModule, syncScrollWidths } from './admin-orders.js';
import { initProductsModule } from './admin-products.js';
import { initCloudAndLogsModule, resetCloudAndLogsState } from './admin-cloud-and-logs.js';
import { initSettingsModule } from './admin-settings.js';
// Phase 2: these two were <script type="module"> tags in admin.html, running
// for every visitor outside this file's role gate. They are now ordinary
// feature modules, initialised below only after the admin role is verified and
// torn down on logout like everything else.
import { initAnalyticsModule, disposeAnalyticsModule } from './admin-analytics.js';
import { initNotificationsModule, disposeNotificationsModule } from './admin-notifications.js';

document.addEventListener('DOMContentLoaded', () => {

    // Initialize EmailJS.
    // SECURITY/CORRECTNESS: never ship the literal placeholder. Initialising
    // the SDK with a bogus key leaves a broken client on the page that fails
    // at send time, deep inside an order flow. Set the real public key here
    // (it is public by design) or leave the SDK uninitialised.
    const EMAILJS_PUBLIC_KEY = ''; // <-- set to the real EmailJS public key
    if (typeof emailjs !== 'undefined' && EMAILJS_PUBLIC_KEY) {
        emailjs.init(EMAILJS_PUBLIC_KEY);
    }

    const loginView = document.getElementById('login-view');
    const dashboardView = document.getElementById('dashboard-view');
    
    // Navigation & Layout Elements
    const navOrders = document.getElementById('nav-orders');
    const navProducts = document.getElementById('nav-products');
    const navCustomers = document.getElementById('nav-customers');
    const navSupport = document.getElementById('nav-support');
    const navAnalytics = document.getElementById('nav-analytics');
    const navCloudDrive = document.getElementById('nav-cloud-drive');
    const navLogs = document.getElementById('nav-logs');
    const navSettings = document.getElementById('nav-settings');
    
    const ordersSection = document.getElementById('orders-section');
    const productsSection = document.getElementById('products-section');
    const customersSection = document.getElementById('customers-section');
    const supportSection = document.getElementById('support-section');
    const analyticsSection = document.getElementById('analytics-section');
    const cloudDriveSection = document.getElementById('cloud-drive-section');
    const logsSection = document.getElementById('logs-section');
    const settingsSection = document.getElementById('settings-section');
    
    const logoutBtn = document.getElementById('logout-btn');
    const mobileLogoutBtn = document.getElementById('mobile-logout-btn');

    // Guards against double-initialisation if onAuthStateChanged re-fires for
    // an already-verified session (e.g. silent token refresh). Re-running the
    // init functions would attach a second copy of every listener.
    let modulesInitialised = false;

    // The uid the feature modules were bound to. Modules capture their user in
    // a closure at init time and cannot be re-pointed at a different account,
    // so a second, different admin signing in inside the same tab must get a
    // fresh document rather than a dashboard still wired to the previous uid.
    let initialisedUid = null;

    // Authoritative in-page answer to "is the current session a verified
    // admin?". Navigation and every tab-activation fetch are gated on it, so
    // un-hiding #dashboard-view from devtools cannot drive feature code.
    let isAdminSession = false;

    // LOGIN is an event, not a state. onAuthStateChanged also fires on page
    // load and on silent token refresh; logging on every callback floods the
    // immutable audit trail with phantom logins.
    let loggedLoginForUid = null;

    /**
     * Wipes every trace of the previous session from the DOM.
     *
     * The dashboard markup ships with the page, so hiding it on logout leaves
     * customer names, e-mails, phones, addresses, orders and audit entries
     * sitting in the document for the next person at the keyboard to reveal
     * with one classList tweak. Clearing the containers is the only thing that
     * actually removes the data.
     */
    function purgeSensitiveDashboardState() {
        const tableBodies = [
            'orders-table-body', 'products-table-body', 'customers-table-body',
            'support-table-body', 'logs-table-body', 'views-per-product-body'
        ];
        tableBodies.forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = '';
        });

        [
            'cloud-drive-file-list', 'admin-notifications-list',
            'recent-searches-list', 'most-ordered-products-legend', 'categories-list'
        ].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = '';
        });

        [
            'add-variations-table-container', 'edit-variations-table-container',
            'edit-image-inputs', 'csv-preview-tbody', 'log-metadata-content',
            'add-product-image-preview-wrap', 'edit-product-image-preview-wrap'
        ].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = '';
        });

        // Quill keeps its content in a contenteditable div, which no form
        // reset touches.
        document.querySelectorAll('#add-description-editor .ql-editor, #edit-description-editor .ql-editor')
            .forEach((editor) => { editor.innerHTML = ''; });

        [
            'order-search-id', 'order-search-email', 'order-search-date',
            'product-search-input', 'logs-search-input', 'csv-file-input',
            'cloud-drive-file-input', 'add-product-image-url', 'edit-product-image-url'
        ].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });

        ['edit-modal', 'bulk-import-modal', 'log-metadata-modal', 'add-product-container',
         'admin-notifications-dropdown', 'upload-progress-container']
            .forEach((id) => {
                const el = document.getElementById(id);
                if (el) el.classList.add('hidden');
            });

        try {
            resetCloudAndLogsState();
        } catch (error) {
            console.warn('[admin] Could not reset cloud/logs module state:', error);
        }

        disposeCategoryTree();
        disposeCatalogSnapshot();

        // Analytics holds four live Chart.js instances and the revenue
        // figures; notifications holds an OPEN onSnapshot subscription that
        // would otherwise keep streaming admin data into a signed-out page.
        try {
            disposeAnalyticsModule();
        } catch (error) {
            console.warn('[admin] Could not dispose the analytics module:', error);
        }

        try {
            disposeNotificationsModule();
        } catch (error) {
            console.warn('[admin] Could not dispose the notifications module:', error);
        }
    }

    // ==========================================
    // 1. AUTHENTICATION & SECURITY LOCK
    // ==========================================
    startTenantBridge({
        onReady(context) {
            const user = context.currentUser;
            if (modulesInitialised) {
                if (initialisedUid !== user.uid) window.location.reload();
                return;
            }
            setCurrentUser(user);
            isAdminSession = true;
            modulesInitialised = true;
            initialisedUid = user.uid;
            loginView.classList.add('hidden');
            dashboardView.classList.remove('hidden');
            dashboardView.classList.add('flex');
            initOrdersModule(context);
            initProductsModule(context);
            initCloudAndLogsModule(context);
            initSettingsModule(context);
            initAnalyticsModule(context);
            initNotificationsModule(context);
            if (loggedLoginForUid !== user.uid) {
                loggedLoginForUid = user.uid;
                void logAdminAction('LOGIN', 'system', 'Επιτυχής σύνδεση στο SQySystems Merchant Portal.');
            }
        },
        onLocked() {
            isAdminSession = false;
            setCurrentUser(null);
            if (modulesInitialised) purgeSensitiveDashboardState();
            dashboardView.classList.add('hidden');
            dashboardView.classList.remove('flex');
        }
    });

    const performLogout = async () => {
        // Lock immediately; logging is best effort and must not delay logout.
        if (getCurrentUser()) void logAdminAction('LOGOUT', 'system', 'Αποσύνδεση διαχειριστή.');
        await logoutPortal();
    };
    logoutBtn?.addEventListener('click', performLogout);
    mobileLogoutBtn?.addEventListener('click', performLogout);

    // ==========================================
    // 2. DASHBOARD NAVIGATION
    // ==========================================
    function resetNavStyles() {
        const allNavButtons = [navOrders, navProducts, navCustomers, navSupport, navAnalytics, navCloudDrive, navLogs, navSettings].filter(Boolean);
        const allSections = [ordersSection, productsSection, customersSection, supportSection, analyticsSection, cloudDriveSection, logsSection, settingsSection].filter(Boolean);

        allNavButtons.forEach(btn => {
            btn.classList.replace('text-neutral-900', 'text-neutral-400');
            btn.classList.replace('border-neutral-900', 'border-transparent');
            btn.classList.remove('font-semibold');
        });
        
        allSections.forEach(sec => {
            sec.classList.add('hidden');
        });
    }

    // Navigation gate. Registered BEFORE every per-button handler, so a click
    // arriving while no verified admin session exists is stopped here and the
    // adminTabActivated fetches (customers, support, logs, orders) never run.
    // Without it, un-hiding #dashboard-view in devtools is enough to fire the
    // feature fetches; they would be refused by the Firestore rules, but the
    // gate keeps the refusals — and the intent — from ever leaving the page.
    [navOrders, navProducts, navCustomers, navSupport, navAnalytics,
     navCloudDrive, navLogs, navSettings].filter(Boolean).forEach((btn) => {
        btn.addEventListener('click', (event) => {
            if (!isAdminSession) {
                event.preventDefault();
                event.stopImmediatePropagation();
            }
        });
    });

    navOrders.addEventListener('click', () => {
        resetNavStyles();
        navOrders.classList.replace('text-neutral-400', 'text-neutral-900');
        navOrders.classList.replace('border-transparent', 'border-neutral-900');
        navOrders.classList.add('font-semibold');
        ordersSection.classList.remove('hidden');
        syncScrollWidths();
        window.dispatchEvent(new CustomEvent('adminTabActivated', { detail: { sectionId: 'orders-section' } }));
    });

    navProducts.addEventListener('click', () => {
        resetNavStyles();
        navProducts.classList.replace('text-neutral-400', 'text-neutral-900');
        navProducts.classList.replace('border-transparent', 'border-neutral-900');
        navProducts.classList.add('font-semibold');
        productsSection.classList.remove('hidden');
        window.dispatchEvent(new CustomEvent('adminTabActivated', { detail: { sectionId: 'products-section' } }));
    });

    navCustomers.addEventListener('click', () => {
        resetNavStyles();
        navCustomers.classList.replace('text-neutral-400', 'text-neutral-900');
        navCustomers.classList.replace('border-transparent', 'border-neutral-900');
        navCustomers.classList.add('font-semibold');
        customersSection.classList.remove('hidden');
        window.dispatchEvent(new CustomEvent('adminTabActivated', { detail: { sectionId: 'customers-section' } }));
    });

    navSupport.addEventListener('click', () => {
        resetNavStyles();
        navSupport.classList.replace('text-neutral-400', 'text-neutral-900');
        navSupport.classList.replace('border-transparent', 'border-neutral-900');
        navSupport.classList.add('font-semibold');
        supportSection.classList.remove('hidden');
        window.dispatchEvent(new CustomEvent('adminTabActivated', { detail: { sectionId: 'support-section' } }));
    });

    // Analytics previously wired its own click handler, its own section
    // hiding and its own nav restyling from inside admin-analytics.js — a
    // second implementation of tab switching racing this one for the same
    // classList. Owning it here makes every tab behave identically, and the
    // module just listens for the event.
    if (navAnalytics) {
        navAnalytics.addEventListener('click', () => {
            resetNavStyles();
            navAnalytics.classList.replace('text-neutral-400', 'text-neutral-900');
            navAnalytics.classList.replace('border-transparent', 'border-neutral-900');
            navAnalytics.classList.add('font-semibold');
            analyticsSection.classList.remove('hidden');
            window.dispatchEvent(new CustomEvent('adminTabActivated', { detail: { sectionId: 'analytics-section' } }));
        });
    }

    if (navCloudDrive) {
        navCloudDrive.addEventListener('click', () => {
            resetNavStyles();
            navCloudDrive.classList.replace('text-neutral-400', 'text-neutral-900');
            navCloudDrive.classList.replace('border-transparent', 'border-neutral-900');
            navCloudDrive.classList.add('font-semibold');
            cloudDriveSection.classList.remove('hidden');
            window.dispatchEvent(new CustomEvent('adminTabActivated', { detail: { sectionId: 'cloud-drive-section' } }));
        });
    }

    if (navLogs) {
        navLogs.addEventListener('click', () => {
            resetNavStyles();
            navLogs.classList.replace('text-neutral-400', 'text-neutral-900');
            navLogs.classList.replace('border-transparent', 'border-neutral-900');
            navLogs.classList.add('font-semibold');
            logsSection.classList.remove('hidden');
            // No direct fetchAdminLogs(true) here: the adminTabActivated
            // listener in admin-cloud-and-logs.js already runs it, and calling
            // both read the first page of audit logs twice on every click.
            window.dispatchEvent(new CustomEvent('adminTabActivated', { detail: { sectionId: 'logs-section' } }));
        });
    }

    if (navSettings) {
        navSettings.addEventListener('click', () => {
            resetNavStyles();
            navSettings.classList.replace('text-neutral-400', 'text-neutral-900');
            navSettings.classList.replace('border-transparent', 'border-neutral-900');
            navSettings.classList.add('font-semibold');
            settingsSection.classList.remove('hidden');
            window.dispatchEvent(new CustomEvent('adminTabActivated', { detail: { sectionId: 'settings-section' } }));
        });
    }

    // ==========================================
});
