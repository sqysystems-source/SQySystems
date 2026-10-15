# SQySystems Managed Agency Portal

This is the **complete latest supplied project**, upgraded from
`sqysystems(1).txt`. Merchants enter their store email/password once, from either
`index.html` or `public/admin.html`, and sign in directly to their own store's
Firebase Auth. No Master merchant login, profile connection setup, JSON form or
store-configuration controls are shown to merchants.

## Agency owner: first action

In **`public/js/tenant-config.js`**, complete the clearly marked
`AURA_FIREBASE_CONFIG` block with the six public web config values copied from
Firebase Console → **test-db-f6315** → Project settings → Your apps.

The supplied latest source did not contain AURA's apiKey, storageBucket,
messagingSenderId or appId. These are intentionally marked `PASTE_AURA_...`;
they have not been invented. Until those values are filled, login fails safely
with a support message. No merchant setup screen appears.

The following routing is already configured:

| Setting | Value |
| --- | --- |
| Merchant email | `kostas6603@gmail.com` |
| Store slug / name | `aura` / `AURA` |
| Store API origin | `https://www.sqysystemsdev.org` |
| Tenant project | `test-db-f6315` |
| Web config block | `AURA_FIREBASE_CONFIG` in `public/js/tenant-config.js` |

Then follow **[DEPLOYMENT.md](DEPLOYMENT.md)**. The merchant uses an existing
email/password account in the tenant project whose `users/{tenantUid}` has
`role: "admin"`. No Master account or matching Master UID/password is required.

## Merchant behavior

- The admin page has one Email/Password form. The code-owned email directory
  selects the tenant; the tenant Auth password and server-read admin role select
  whether access is granted.
- The landing-page login recognizes registered merchant emails and uses the
  same session service. It navigates to the admin page **only after** verifying
  the tenant admin role. The admin page restores Firebase's same-origin,
  same-tab session and verifies the role again; it never resubmits a password.
- Wrong passwords, unassigned emails, missing agency configuration, unavailable
  storage/network and non-admin accounts show friendly errors with no setup UI.
- Existing general agency client accounts keep the Master profile/login flow.
  Registered merchant emails always take the tenant path, including password
  reset. A registered merchant's failed login never falls back to Master.
- The navbar's **Open Store Admin Panel** link is visible before agency login,
  so store owners do not need a Master account to reach their workspace.
- Refresh resumes a verified tenant session. Logout clears the tenant session
  and locator. Tenant logout/account change, role deletion/revocation or profile
  listener errors lock the panel, clear visible data and reload cleanly.

Session persistence is tab-scoped. Keep the landing page and admin on the same
hostname (`sqysystems.com` OR `www.sqysystems.com`) when navigating. Passwords
and tokens never appear in navigation URLs or application-created handoff data.
Firebase owns its authentication persistence; the portal stores only a locator
containing version, normalized email, slug and tenant UID. It revalidates that
locator against the current directory, Firebase Auth identity and server role.

## Agency-controlled directory

`STORE_DIRECTORY` is deliberately maintained in code. Add an entry with a
unique slug, allowed merchant emails, store name, HTTPS backend origin and web
config. An email must map to exactly one store. This release does not expose a
public Master Firestore email directory or implement the optional Firestore
fallback: no Master read or login is needed by the merchant session service.

The supplied Master rules now deny client writes to `tenantStore`, `storeSlug`
and `role` in profiles. Legacy profile connection fields may remain but are
ignored by routing. `store_directory` is reserved and denied to browser clients;
trusted agency Admin SDK/Console operations remain possible. Do not create a
publicly writable directory to let merchants choose backend origins.

Firebase web config and emails in static JavaScript are publicly inspectable.
They are configuration, not an authorization boundary. Do not put service-account
private keys, Firebase Admin credentials, R2 secrets or Resend keys here. Tenant
Firestore rules and backend token/role verification remain required.

## Main files

| File | Responsibility |
| --- | --- |
| `public/js/tenant-config.js` | Developer-only AURA config block and managed email directory |
| `public/js/merchant-session.js` | Shared direct tenant login, role verification, restore, reset and logout |
| `public/js/tenant-bridge.js` | Single-form portal UI and verified-session lifecycle |
| `public/js/admin.js` | Existing feature initialization after verified tenant login |
| `app.js` | Merchant routing from the landing-page modal; preserved agency client flow |
| `firestore.rules` | Master profiles/messages and agency-controlled routing fields |

All existing admin feature modules, taxonomy, brands, pricing, snapshots,
analytics, order tools, R2 routing and tenant Bearer headers are retained from
the newest supplied source. `firebase-config.js` still configures the agency
website's Master project; the tenant bridge does not import it.

## Verification

Run with Node 20+ (Node 24 used here):

```sh
npm test
```

No dependency installation is needed for these tests. **28 tests passed**:
managed login from both pages, same-session restore, tenant-only credentials,
wrong-password retry, non-admin rejection, missing config, unknown email,
locator tampering, revoked role, account change, logout, persistence failure,
password reset routing, retained agency login/signup behavior and isolation
between stores. Syntax, the actual ES module import/export graph, local HTML
assets and JSON configurations were also checked.

The session and UI tests run actual auth/form/orchestrator code with mocked
Firebase, feature initialization and a controlled DOM. They are not live Firebase,
Firestore Rules emulator, browser layout, R2 or Resend tests. Real-project login
cannot be verified here without the missing AURA config values and a configured
tenant account; complete the acceptance checks in `DEPLOYMENT.md`.

The source export referenced `favicon.svg` but did not include its bytes; a small
SVG fallback is included. No live Firebase rules, account, database or deployment
was changed while creating this ZIP.
