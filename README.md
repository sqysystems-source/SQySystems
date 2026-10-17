# SQySystems Project Studio

Updated from **`SQySystems-main (5)(1).zip`** with an interactive project builder
and live request management in SQy Admin. The managed merchant session fix remains.

- Hero, service and client-dashboard project buttons open the four-stage studio.
- Guests submit contact details; Master clients auto-bind to their signed-in
  account. Tenant-only merchants remain separate from Master Auth.
- Requests are saved to Master `project_requests` and appear live in the protected
  Project requests view, with full answers, status actions and payment/store form
  prefill. The general contact form stays available.

**Publish the updated Master rules before deploying this version.**
See [DEPLOYMENT.md](DEPLOYMENT.md), [PROJECT_REQUESTS.md](PROJECT_REQUESTS.md),
[CHANGES.md](CHANGES.md) and [TEST_RESULTS.md](TEST_RESULTS.md).

---

# SQySystems — Agency Control Plane

Complete integrated project based on the supplied **`SQySystems-main (4).zip`**, including the landing-session fix.
The existing merchant workspace remains at `/public/admin.html`; the agency's
new Master-only workspace is **`/sqy-admin.html`**.

## First launch

1. Publish the root `firestore.rules` to Master **sqysystems-faa0e**.
2. In Master Firebase Auth, create/reuse your agency administrator account. In
   Master Firestore, set `users/{THAT_MASTER_UID}.role` to `superadmin` or `admin`
   through the Console or trusted Admin SDK. Keep the profile's `uid` field equal
   to its Auth UID. No browser account can grant itself this role.
3. Deploy this complete folder to the agency Vercel project, retaining static
   output directory `.`.
4. Open `/sqy-admin.html` and sign in with the **Master account**, not a tenant
   customer's credentials. After sign-in, the landing page also shows SQy Admin
   in its navbar/dashboard for this Master role.
5. Store connections come exclusively from Master `merchant_stores/{emailLower}`.
   Existing connections are retained. There is no local AURA fallback.

## Landing-session fix (17 October 2026)

Merchant login authenticates the external store's Firebase Auth. The landing
page now restores that same verified session on return instead of checking only
Master Auth. Returning to the homepage stays on the homepage with the merchant
shown as signed in, the connected store name, Logout and Open Store Admin Panel.
A new login still redirects to the store admin as before.

Restoration rechecks actual Firebase Auth, directory status, UID/email and the
tenant's admin role. Local storage alone never grants access. Directory/profile
changes revoke the landing session too. Navigation preserves the session;
Logout ends it. Browser back/forward cache restoration reloads to revalidate.

Master and tenant identities remain separate. A Master Firestore profile is not
proof of Master Auth sign-in. Tenant sessions show the tenant profile and cannot
edit Master company details or gain SQy Admin access. The agency profile form
remains available to independently signed-in Master users. No second login,
credential copying or automatic Master account creation was added.

## What's in SQy Admin

- Live KPIs: number of Master user profiles, unread contact tickets, paid orders
  and active `merchant_stores` records.
- Registered client directory with search, pagination, profile/role/member date,
  connection status and **Connect / Edit E-Shop** actions.
- Contact inbox with unread/read/resolved status, mailto reply, deletion and live
  counts. Legacy messages with no status count as unread. Reply opens your mail
  client; nothing is automatically emailed.
- A prominent paid-client side panel showing request/package, euros paid, date
  and Pending Setup / Store Connected status, derived from the live directory.
- Manual **Add paid client / order** form and **Setup Tenant & API Keys** on every
  paid row. No payment processor is connected and no demo financial records are
  inserted automatically.
- Provisioning drawer with registered/paid client selection, merchant email,
  store name, API origin, plan/status and six public Firebase fields. It accepts
  JSON or a literal `const firebaseConfig = { ... };` snippet without executing
  pasted code. Expressions, private keys and service-account fields are rejected.
- Edit, Enable/Disable, Delete and restore/edit for store connections. Concurrent
  edits are checked in transactions to avoid silently replacing newer keys.

Only a verified Master `admin`/`superadmin` starts protected collection listeners.
Writes also recheck the server role. Master role revocation and sign-out stop
subscriptions, close dialogs and purge client/config/payment data from the UI.
Firestore rules enforce the permissions independently of the page.

## Routing contract

Login now checks the exact **`merchant_stores/{emailLower}`** document in Master
from the server. It never lists the directory for merchants and does not require
Master sign-in. The same routing is used for landing login, direct portal login,
password reset and remembered-session restore.

1. Existing active record → use its config, then authenticate in the tenant and
   verify `users/{tenantUid}.role === 'admin'` from that tenant's server.
2. Confirmed missing record → no merchant connection; direct portal login is denied. The homepage may use ordinary Master login for an agency account.
3. Disabled, deleted or malformed record → block; never fall back to the seed or
   attempt the merchant password against Master.
4. Master network/permission failure → fail closed, rather than using stale cache
   or silently bypassing the directory.

The directory is checked again before feature initialization and watched while
the merchant workspace is open. Disable/delete or routing changes lock that
workspace and require a fresh session. An existing saved session is rechecked
against current routing, Firebase identity and tenant admin role on reload.

**Delete retains a `status: "deleted"` tombstone.** It disappears from the default
connections view but remains available under Deleted for restore/edit. Keeping
this record allows restoring/editing the connection from the Deleted filter.
There is no local seed; a missing document cannot authorize merchant access.
Disabling a portal connection does not revoke a tenant's underlying Firebase
admin role or direct API credentials; revoke that tenant role separately when
all store access must end.

Saving a connection config does **not** create a Firebase project/Auth account,
assign tenant admin permissions, deploy an e-shop or configure API/bucket CORS.
It connects an already provisioned store. Existing tenant rules/backend token
checks and [ESHOP_CORS_INSTRUCTIONS.md](ESHOP_CORS_INSTRUCTIONS.md) still apply.

## Master data

| Collection | Access / purpose |
| --- | --- |
| `users/{uid}` | Owner profile access with immutable role/routing fields; admins can read/list all profiles |
| `messages/{id}` | Public validated create; admin-only read, status update and delete |
| `client_payments/{id}` | Admin-only manual paid-order records, integer euro cents and timestamps |
| `merchant_stores/{emailLower}` | Public single-document get for login; admin-only list and writes |
| `store_directory` | Old reserved collection stays client-denied |

Store directory documents contain only the requested **public web config**,
merchant email, store name/API origin, plan, status and updatedAt. Firebase web
config is not a service-account secret. Because exact email lookups are public,
do not put private notes, payment details, Resend/R2 keys or private keys here.
Rules reject extra fields in records written through the client.

Master roles and tenant roles are independent, even if both accounts use the
same email. To access SQy Admin when your email also maps to a merchant, log in
on `/sqy-admin.html` directly: the homepage Login modal deliberately routes mapped
merchant emails to their tenant. Existing Master agency client accounts still
use the homepage's normal Master login/profile flow.

## Landing page fixes

The navbar's Open Store Admin Panel button defaults to hidden and is shown only
in either the verified merchant view or the authenticated Master view. Guests retain Login/Sign Up. Merchants signing
in through the login modal still go straight to their store workspace. SQy Admin
links are independently gated on the verified Master role.

Contact labels now use `#f1f4f8`; the character counter, including its nested
number span, uses `#c3ccd5`. Scoped selectors override the later generic form
styles that previously made the labels dark.

## Verification

```sh
npm test
```

**73 current isolated tests passed** (Node 24): both login entry points, landing-session
round trips, dynamic routing with no local fallback, fail-closed disabled/deleted/error cases, role gates and
revocation, provisioning/optimistic edits, manual payments, paid-client setup,
message lifecycle, HTML escaping, safe snippet parsing, navigation visibility,
local assets, JS syntax and the actual ES module import/export graph.

These execute actual service/form/orchestrator code with mocked Firebase,
a controlled DOM and mocked tenant feature initialization. They are not live
Firebase Security Rules enforcement or browser visual tests.

An additional **real Firestore Rules emulator suite** is included as
`tests/firestore-rules.emulator.mjs` and can be run with `npm run test:rules` after
installing its local test dependencies; see DEPLOYMENT.md. It was **not run here**:
the emulator/test SDK dependencies were unavailable. Real browser layout,
production Firebase login/rules, Vercel routing, R2 and Resend remain acceptance
checks. No production data, account, payment, rule or deployment was changed.

Current verification details and legacy-test notes: [TEST_RESULTS.md](TEST_RESULTS.md).
