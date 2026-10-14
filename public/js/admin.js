// public/js/admin.js
//
// ORCHESTRATOR & SHELL.
//
// Owns: navigation, the login form, admin role verification, logout, and
// module initialisation. Owns NO feature logic — orders, products, cloud
// drive, customers, support and audit logs all live in their own modules.
//
// DEPENDENCY INJECTION: feature modules never import auth state. This file
// resolves onAuthStateChanged, verifies the 'admin' role, pushes the verified
// user into admin-utils via setCurrentUser(), then calls each module's
// init*(context). No feature listener is wired until that point, so a
// non-admin session can never reach feature code.
//
// Import graph (acyclic, verified):
//   admin.js -> admin-orders.js         -> admin-utils.js
//            -> admin-products.js       -> admin-cloud-and-logs.js -> admin-utils.js
//            -> admin-cloud-and-logs.js -> admin-utils.js
//            -> admin-settings.js       -> admin-utils.js

import { app, db } from './firebase-config.js';
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js";
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
    const auth = getAuth(app);

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
    
    // Login Elements
    const loginForm = document.getElementById('admin-login-form');
    const loginEmailInput = document.getElementById('admin-email');
    const loginPasswordInput = document.getElementById('admin-password');
    const loginError = document.getElementById('login-error');
    const loginBtn = document.getElementById('login-submit-btn');
    
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
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            try {
                const userDocRef = doc(db, "users", user.uid);
                const userDocSnap = await getDoc(userDocRef);

                if (userDocSnap.exists() && userDocSnap.data().role === 'admin') {
                    // Account switch inside one tab: the modules belong to the
                    // previous uid. Reload rather than hand the new admin a
                    // dashboard holding someone else's closures and cached rows.
                    if (modulesInitialised && initialisedUid !== user.uid) {
                        window.location.reload();
                        return;
                    }

                    // Publish identity BEFORE any module init, so logAdminAction
                    // inside a module never fires with a null user.
                    setCurrentUser(user);
                    isAdminSession = true;
                    showDashboardView();

                    if (!modulesInitialised) {
                        modulesInitialised = true;
                        initialisedUid = user.uid;
                        const context = { currentUser: user, userData: userDocSnap.data() };
                        initOrdersModule(context);
                        initProductsModule(context);
                        initCloudAndLogsModule(context);
                        initSettingsModule(context);
                        initAnalyticsModule(context);
                        initNotificationsModule(context);
                    }

                    if (loggedLoginForUid !== user.uid) {
                        loggedLoginForUid = user.uid;
                        logAdminAction('LOGIN', 'system', 'Επιτυχής σύνδεση διαχειριστή.');
                    }
                } else {
                    isAdminSession = false;
                    loggedLoginForUid = null;
                    setCurrentUser(null);
                    purgeSensitiveDashboardState();
                    showLoginView();
                    alert("Άρνηση Πρόσβασης: Μη εξουσιοδοτημένος λογαριασμός.");
                    await signOut(auth);
                }
            } catch (error) {
                isAdminSession = false;
                loggedLoginForUid = null;
                setCurrentUser(null);
                purgeSensitiveDashboardState();
                console.error("Error verifying admin role:", error);
                showLoginView();
                alert("Άρνηση Πρόσβασης: Αδυναμία επαλήθευσης.");
                await signOut(auth);
            }
        } else {
            isAdminSession = false;
            loggedLoginForUid = null;
            setCurrentUser(null);
            purgeSensitiveDashboardState();
            showLoginView();

            // Feature modules bind their listeners and closures once, at init.
            // After a sign-out they have been disposed and cannot be re-inited
            // without double-attaching, so signing back in inside the same tab
            // would land on a half-dead dashboard. A reload is the only honest
            // clean slate — and it guarantees no previous-session state
            // survives, whatever the purge above may have missed.
            //
            // No loop risk: after the reload there is no user and
            // modulesInitialised is false, so this branch does nothing.
            if (modulesInitialised) {
                window.location.reload();
            }
        }
    });

    function showDashboardView() {
        loginView.classList.add('hidden');
        dashboardView.classList.remove('hidden');
        dashboardView.classList.add('flex');
    }

    function showLoginView() {
        dashboardView.classList.add('hidden');
        dashboardView.classList.remove('flex');
        loginView.classList.remove('hidden');

        // A rejected non-admin sign-in leaves the submit button disabled and
        // reading "Γίνεται σύνδεση...", locking the real admin out of the form
        // until a manual reload. Restore it every time the form comes back.
        if (loginBtn) {
            loginBtn.disabled = false;
            loginBtn.textContent = 'Σύνδεση';
        }
        if (loginForm) loginForm.reset();
    }

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        loginError.classList.add('hidden');
        
        const originalText = loginBtn.textContent;
        loginBtn.textContent = 'Γίνεται σύνδεση...';
        loginBtn.disabled = true;

        try {
            await signInWithEmailAndPassword(auth, loginEmailInput.value.trim(), loginPasswordInput.value);
            loginForm.reset();
        } catch (error) {
            console.error("Login error:", error);
            loginError.textContent = "Λανθασμένα στοιχεία διαχειριστή. Δοκιμάστε ξανά.";
            loginError.classList.remove('hidden');
            loginBtn.textContent = originalText;
            loginBtn.disabled = false;
        }
    });

    const performLogout = async () => {
        if (getCurrentUser()) {
            // Best-effort: a failed audit write must never strand the operator
            // in a signed-in session.
            try {
                await logAdminAction('LOGOUT', 'system', 'Αποσύνδεση διαχειριστή.');
            } catch (error) {
                console.warn('[admin] Could not write the logout audit entry:', error);
            }
        }
        isAdminSession = false;
        setCurrentUser(null);
        purgeSensitiveDashboardState();
        await signOut(auth);
    };

    if (logoutBtn) logoutBtn.addEventListener('click', performLogout);
    if (mobileLogoutBtn) mobileLogoutBtn.addEventListener('click', performLogout);


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
