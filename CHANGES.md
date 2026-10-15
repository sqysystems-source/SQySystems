# SQySystems Super-Admin Control Plane

Baseline: all 30 supplied files in the latest `sqysystems(2).txt`.

- Added the Master-only `sqy-admin.html`, dedicated responsive CSS and root
  controller, with live KPIs, registered clients, contact tickets, paid-client
  side panel, manual payment entry and a provisioning drawer.
- Added shared agency models and Master data service: server role checks,
  protected listeners, status/delete actions, euro-cent validation, exact public
  connection projection and optimistic transactions for concurrent edits.
- Added `merchant-directory.js`: server-only pre-login document gets from
  `merchant_stores/{emailLower}`, active-record override, confirmed-missing AURA
  fallback and fail-closed disabled/deleted/malformed/network behavior.
- Updated merchant login/reset/restore and live session monitoring for dynamic
  mappings while preserving one-step tenant Auth and tenant admin verification.
  New locators store version/email/project/UID; old locators can migrate after
  fresh checks. Directory changes during sign-in are checked before opening UI.
- Kept the latest supplied AURA web config as seed, unchanged. Delete creates a
  blocked tombstone so removing AURA cannot accidentally re-enable its fallback.
- Hid the navbar Store Admin link for guests and added independently role-gated
  SQy Admin links in navbar/dashboard, with live Master profile role monitoring.
- Corrected contact labels/counter contrast with scoped selectors that outrank
  the later generic form styles, including the nested counter number.
- Updated Master rules for admin/superadmin role checks, user directory access,
  ticket management, private manual payments and public-get/admin-list directory
  routing, including field validation and self-promotion prevention.
- Added 35 isolated tests plus a separate real Rules emulator suite and updated
  deployment documentation. Added local emulator/no-store control-plane config.
  Supplied a fallback favicon whose bytes were absent from the text export.

The tenant admin feature modules, existing price/taxonomy/catalog behavior,
Firebase SDK version, store API routing and CORS instructions were retained.
No remote data/accounts/rules/deployments were changed. Isolated tests passed;
actual browser, Firestore emulator and live service checks remain as documented.
