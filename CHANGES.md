# Landing merchant session fix — 17 October 2026

Baseline: the complete uploaded `SQySystems-main (4).zip`.

## Application changes

- `app.js`: restore and watch the existing verified tenant session on homepage load.
  Render connected store identity and merchant navigation without a second login
  or automatic redirect on return. Preserve normal Master login and role monitoring.
- Keep merchant profile data separate from Master profile permissions. Hide the
  Master company editor for tenant sessions and guard its submit handler. Contact
  messages from a merchant session do not falsely claim a Master UID.
- Logout clears both Firebase sessions and the merchant locator; purge identity
  and subscriptions immediately. Stale asynchronous Master profile reads cannot
  replace the current merchant identity.
- `index.html`: identify the agency-only company editor and add a merchant-session note.
- `public/js/tenant-bridge.js`: stop watchers and hide tenant data on pagehide,
  retain the real session during navigation, and reload a bfcache-restored page
  for fresh verification. Do not activate a late login after navigation.

## Verification and documentation

- Added 12 current landing regression scenarios with real modules and mocked Firebase/DOM.
- Updated routing test fixtures for the already removed AURA fallback.
- Retained the obsolete wizard/static-directory suites as `.legacy.mjs` reference
  files; they no longer run as current contract tests. Their original assumptions
  already failed against the supplied source. Current routing/lifecycle cases use
  the shared dynamic-directory harness.
- Updated README/deployment guidance and included honest TEST_RESULTS.md.
- No production dependency, Firebase configuration, rules or tenant data changed.

---

# Historical control-plane changes (precede removal of the local AURA fallback)

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
