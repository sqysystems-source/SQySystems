# Managed Agency Portal upgrade

Baseline: all 24 files in the latest supplied `sqysystems(1).txt`, not an older
project export.

- Removed the entire tenant setup screen and every Configure Store control.
- Replaced Master-then-tenant login with one direct tenant email/password login.
- Added the agency-owned STORE_DIRECTORY and a single AURA_FIREBASE_CONFIG block
  in tenant-config.js. AURA email/domain/project are configured; the real four
  unavailable web values remain explicit placeholders for the agency to fill.
- Added merchant-session.js shared by the landing modal and portal, including
  tenant role checks, same-tab session restore, password reset, safe retry,
  account isolation and live revocation/logout handling.
- Updated landing-page auth to redirect registered merchants after one tenant
  login; preserved ordinary agency client accounts and made the admin link
  visible without Master login. Registered merchants cannot create duplicate
  Master accounts through signup.
- Removed stale setup dependencies from admin.js, simplified portal CSS and
  changed sidebar identity to show only the merchant email, not project details.
- Locked routing fields in Master profile rules. Client directory access is
  denied; static registry routing needs no Master Firestore read.
- Kept existing admin feature modules, API routing and Firebase SDK versions.
  Added a favicon fallback referenced but absent from the latest text export.

Validation: 28 isolated tests passed, including actual ES module graph linking,
syntax, both login entry points, role gates, session restore/tampering,
wrong-password/storage/network failures, store isolation and preserved agency
flows. Tests use mocked Firebase/DOM/feature initialization, not live projects.
Live browser/Firebase Rules/R2/Resend validation remains in DEPLOYMENT.md.
