# Deploy the project configurator

1. Publish this ZIP's root `firestore.rules` to the **SQySystems Master project
   `sqysystems-faa0e` first**. The new `project_requests` rules are required for
   public submission and the protected admin listener. Do not apply Master rules
   to AURA or another tenant project.
2. Deploy the complete folder to the **agency Vercel project** with the existing
   static configuration. Include both new modules `public/js/project-wizard.js`
   and `public/js/project-request-data.js` along with the changed shared models.
3. Deploy as a complete tree. Remove stale duplicate `tests/managed-auth.test.mjs`
   and `tests/portal-lifecycle.test.mjs` if merging into an existing checkout; their
   original contents are retained under `.legacy.mjs` names. No dependency change
   or database migration is needed. The new collection is created on first submit.
4. On the canonical agency hostname, test one guest brief per track. Verify its
   entry in SQy Admin → Project requests, open the details and check all answers.
5. Test a Master client submission (UID/email bound), a tenant-only merchant
   submission (contact prefilled, UID null), statuses, search/filter, deletion,
   and both conversion forms. Verify that opening a payment form does not record
   a payment and that no amount is prefilled.
6. Recheck login → admin → back to website, and Logout. Existing R2/API CORS and
   domain setup remain separate from this frontend/rules change.

See PROJECT_REQUESTS.md and TEST_RESULTS.md. Existing environments do not need to
repeat the older administrator bootstrap guidance below.

---

# Install the landing-session fix

Deploy this complete `SQySystems-main` folder to the **SQySystems agency Vercel project**.
The application changes are `app.js`, `index.html` and `public/js/tenant-bridge.js`.
No dependency upgrades, database migration, rules publication, tenant API or bucket
changes are required for this specific session fix.

1. Deploy all files together to the agency project.
2. Use the same canonical agency hostname for homepage and admin. Your configured
   redirect to `www.sqysystems.com` is suitable. Firebase/sessionStorage sessions do
   not transfer from the old `sqysystems.vercel.app` origin: sign in once on the
   new hostname after changing domains.
3. Log in with a mapped store account. The admin opens as before.
4. Click ← SQySystems: homepage should show your email, store name and Logout.
5. Refresh, then reopen the admin: no second password prompt in the same tab.
6. Click Logout on the homepage: the store session ends too. Browser Back must
   not reopen an authorized dashboard without fresh verification.

The merchant view does not edit the agency company profile. That form needs
an independent Master Auth session. The existing Master profile/roles/registered
clients directory are not automatically changed by tenant login.

Below is the general installation reference for new environments. Existing
configured environments do not need to repeat bootstrap/rules steps for this fix.

---

# Deploy SQy Admin and dynamic merchant routing

## 1. Publish Master rules first

Root `firestore.rules` belongs to **sqysystems-faa0e**. Publish it via Master
Firebase Console → Firestore → Rules, or your Firebase CLI:

```sh
firebase deploy --only firestore:rules --project sqysystems-faa0e
```

Do **not** deploy this file to test-db-f6315 or any client store. The tenant's
existing product/order/settings rules stay unchanged.

Deploy the rules before testing the new login router: it now needs a public
single-document get on `merchant_stores/{emailLower}` even when no document exists.
A denied/unavailable lookup intentionally does not bypass the directory.

The rules additionally enforce:

- Master `admin` / `superadmin` role for all users-list, inbox, paid-order and
  directory-management operations.
- Owner-only profile writes, immutable UID/role/routing fields and no client
  deletion of user profiles. Admins can read/list profiles; role assignment
  remains a trusted Console/Admin SDK action.
- Contact validation on public create, admin-only status changes and deletion.
- Validated paid records with positive integer euro cents, immutable creator/
  creation date and server updated timestamps.
- Exact public directory fields, six public Firebase config fields, normalized
  merchant email/document ID, HTTPS origin, active/disabled/deleted status and
  server updatedAt. No private keys, billing notes or other extra fields.

## 2. Bootstrap your agency administrator

In **Master Authentication**, create/reuse the account you will use for agency
operations. Copy that Master Auth UID. In **Master Firestore** open/create its
`users/{uid}` profile and set fields such as:

```text
uid: "THE_MASTER_AUTH_UID"
email: "YOUR_AGENCY_LOGIN_EMAIL"
displayName: "Agency Owner"
company: "SQySystems"
role: "superadmin"
```

An existing `role: "admin"` also works. Never put this role on an arbitrary
public signup through the browser, never use an e-shop customer UID by mistake,
and do not weaken the rules to let a user self-promote.

Visit **`https://sqysystems.com/sqy-admin.html`** and use this Master email/password.
The page itself has a Master login form and does not use merchant routing. The
SQy Admin navbar/dashboard link appears after a Master role check on the homepage.

If `kostas6603@gmail.com` is also your Master owner email, use `/sqy-admin.html`
for agency login. The homepage modal continues to route that mapped email to
AURA's tenant. The two Firebase accounts can have different UIDs/passwords.

## 3. Deploy all source files together

Use the existing Vercel project: Framework Other, no build command, output `.`.
Upload the complete folder, including the new root `sqy-admin.html`,
`sqy-admin.css`, `sqy-admin.js` and these new modules:

```text
public/js/agency-model.js
public/js/merchant-directory.js
public/js/control-plane-data.js
```

The updated session/routing and landing files must deploy with them. Do not
replace these with an old tenant bridge. The Firebase browser SDK stays at
10.13.1; production remains a static ES-module site with no npm build dependency.

The existing framing/CSP/referrer protections and `/customer.html` alias remain.
The control-plane assets now also get no-store and noindex headers. The current
favicon reference is satisfied by an included SVG fallback; no image bytes were
present in the source export.

Keep login and navigation on one canonical agency hostname. Session restoration
from the landing modal to the merchant page is same-origin and same-tab. Add the
agency's production/staging hostnames to Master and tenant Auth authorized domains
as appropriate; do not forward a password or token in a redirect URL.

## 4. Manage AURA in Master

There is no hardcoded AURA configuration or fallback. The existing active
`merchant_stores/kostas6603@gmail.com` connection remains authoritative.

Inside SQy Admin → Store connections, edit the existing record, or select
Connect e-shop and enter the merchant email, store name, API origin and six
public web config fields from the store's Firebase Console. The old AURA seed
button is a legacy control and cannot recover removed config values.

This writes the following shape to `merchant_stores/kostas6603@gmail.com`:

```text
merchantEmail: "kostas6603@gmail.com"
storeName: "AURA"
storeApiBaseUrl: "https://www.sqysystemsdev.org"
plan: "Custom E-Shop"
status: "active"
firebaseConfig: { apiKey, authDomain, projectId, storageBucket,
                  messagingSenderId, appId }
updatedAt: server timestamp
```

These values are the only merchant mapping. Edit future keys/domain/plan/status
inside SQy Admin; no frontend deployment is needed for a new dynamic connection.

The public record intentionally contains no other private fields. A public caller
can get a document for a known email, as needed by pre-login routing, but cannot
query/list the collection. Do not add service-account credentials, private keys,
Resend/R2 secrets, invoices or internal billing notes to these records.

## 5. Add a client and record a payment

The client directory reads Master Firestore `users`. It does not enumerate
Firebase Auth users who have no profile document. Existing signups create their
own profiles; alternatively, use trusted agency provisioning.

For a paid request, choose **Add paid client / order** and enter email, name,
package details, euros paid and payment date. This saves a private admin-only
`client_payments` record with `source: "manual"`, `status: "paid"`, `currency:
"EUR"`, `amountCents`, paidAt, createdBy and server timestamps.

No money is charged, no receipt is issued and no demo paid records are inserted.
Each row's Setup Tenant & API Keys opens the provisioning drawer for its email.
The provisioning badge is derived from an active Master directory record, so
editing/disabling the connection immediately changes Pending Setup / Store
Connected without storing a stale payment-status copy.

## 6. Connect another tenant

From a registered client row, paid-client card or **Connect e-shop**:

- Select/type the merchant email. It is lowercased and used as the document ID.
- Enter store name, plan, HTTPS API origin and status.
- Enter the six public web fields or paste the Firebase Console config object.
  JSON and a literal JS declaration with quoted strings/comments/trailing commas
  are supported. Optional measurementId/databaseURL are ignored when importing.
  Expressions/scripts/service accounts are rejected; no pasted code executes.
- Save. Existing edits check the last loaded record version to reject conflicting
  concurrent changes. Reopen the form if someone changed it while it was open.

The target Firebase project, email/password Auth account, tenant Firestore
`users/{tenantUid}.role = "admin"` and tenant backend must already exist. This
panel stores the connection; it does not create those external resources.
A merchant does not need a matching Master account or Master password.

Store API URLs are plain HTTPS origins, not Markdown links or `/api` paths.
Existing R2/email handlers must verify THIS tenant's ID tokens and admin role,
with the CORS configuration in ESHOP_CORS_INSTRUCTIONS.md. R2 buckets must allow
the agency origin separately for direct presigned uploads.

## 7. Disable, delete and restore

Disable blocks portal login/restore and locks an open merchant workspace through
its directory listener. Enable makes the existing mapping available again.

Delete removes the connection from the default list by setting status `deleted`.
It retains a restorable record. Use the Deleted filter and Restore / Edit to
reactivate it. A missing document cannot enable a merchant session. Other tenant/customer/product
or payment data is not deleted by removing a connection.

Directory changes do not revoke the tenant's underlying Firebase Auth identity or
its direct API permissions. If you need to remove all tenant admin access, also
revoke its tenant Firestore role / credentials using the tenant's trusted tools.

## 8. Tests and real-project acceptance

The included 73 current isolated tests require Node 20+ (Node 24 was used) and no packages:

```sh
npm test
```

For actual Firestore Security Rules emulator checks, use a local development
machine with Java and Firebase CLI support. Install local **test-only** dependencies
(the production page still loads SDK 10.13.1 from its existing CDN):

```sh
npm install --no-save firebase @firebase/rules-unit-testing firebase-tools
npm run test:rules
```

The emulator command uses only `demo-sqysystems` and port 8085. Its script refuses
to run against a non-local emulator. It exercises anonymous get/no-list routing,
owner vs admin access, self-promotion denial, private inbox/payment reads,
validated admin writes, and public-field/secret-smuggling rejection. This suite
was included but not executed here because its dependencies were unavailable.

Complete these checks on staging before production use:

- Guests see Login/Sign Up, not navbar Store Admin or SQy Admin. A normal Master
  client sees Store Admin but not SQy Admin. A Master admin sees both, and role
  removal hides SQy Admin again.
- Contact Name/Email/Message labels and the nested 0/2000 counter are readable.
- Anonymous/ordinary users cannot open SQy Admin data or directly read/list its
  users, messages, payments or merchant directory; a public single directory
  get still works.
- Both `admin` and `superadmin` roles load all four live datasets and accurate
  KPIs; legacy status-less messages count as unread.
- Create a test contact submission; mark Read/Resolved, open its mailto draft and
  delete the test ticket. No automated outbound message should be sent.
- Log a test payment; verify the cents/date/name/package, open its setup drawer,
  provision a tenant and see Store Connected. Test two concurrent edit forms.
- Sign a merchant in from both entry points; confirm one password entry, tenant
  Auth/role verification and tenant API tokens. Add an email absent from the
  static seed and verify its dynamic connection works.
- Disable/delete AURA and confirm it cannot fall back to the seed, including an
  already open merchant tab. Check changes while a login is in progress.
- Sign out/revoke Master role and verify rows, config fields, dialogs and live
  listeners are cleared. Verify mobile navigation, dialogs and logout.
- Check actual products/orders/settings, catalog updates, drive/media uploads,
  presigned downloads and a shipment email to a test recipient.

Live Firebase, deployed browser layout/routing and R2/Resend have not been tested
from this environment. No production resources were changed by producing the ZIP.
