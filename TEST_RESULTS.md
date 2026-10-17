# Project configurator verification — 17 October 2026

## Passed

**73 current isolated tests passed, 0 failed, 0 skipped, 0 cancelled.** Node 24.

```sh
npm test
```

The suites were also run sequentially with TAP output:

```sh
node --experimental-vm-modules --test --test-concurrency=1 --test-reporter=tap tests/*.test.mjs
```

## New project coverage (18 cases)

- Valid complete model projection for all four solution tracks.
- Invalid enums, wrong-track/duplicate features, spoofed/oversized fields.
- Full guest wizard completion and Master-only storage across all four branches.
- Step validation, Back navigation and preserving brand answers.
- Clearing previous-track scope answers on category changes.
- Auto-binding a Master account and keeping tenant-only UIDs unbound.
- Removing account binding/prefill on logout while retaining the project draft.
- Rejecting a spoofed Master UID/email in the submission service.
- Preventing duplicate submission from repeated clicks.
- Admin newest-first list, independent new counter, filters and global search.
- Complete request details and escaping malicious HTML in answers.
- Status updates and form-prefill conversions without fabricated payment records.
- Admin-only mutations; clearing drawers/lists/listeners on role revocation.
- Deleting only the selected request and closing its details.
- Failed Firestore submission retains data and allows retry without false success.

The existing 55 current cases also pass: managed merchant login/return/logout,
Master/tenant separation, directory routing, provisioning, role gates, ticket and
payment workflows, input safety, product helpers, local assets, JavaScript syntax
and linking the actual ES module graph, including the new wizard/data modules.

## Additional static checks

- Parsed index.html, sqy-admin.html and public/admin.html with lxml; IDs unique.
- Checked all four wizard steps, five project CTA entry points and input labels.
- Checked balanced strings/delimiters in Firestore rules. This is not a rules compiler.

## Rules emulator suite included, not executed here

`tests/firestore-rules.emulator.mjs` now also exercises project guest creation,
UID/email ownership binding, validation of status/length/features, guest and
cross-account read denial, owner queries, admin status edits, immutable answers
and creation time, and protected deletion. It runs only against a local demo
emulator via `npm run test:rules`; never a production Firebase project.

The Firebase test SDK, Firebase CLI/emulator dependencies and Chromium were not
available in this environment. The emulator suite and real-browser rendering,
keyboard/focus, responsive layout, bfcache behavior and live Firebase enforcement
were not executed. The automated UI checks use a controlled DOM and Firebase mocks.
No real emails, payments, production documents, rules or deployments were changed.

## Legacy duplicate cleanup

The supplied ZIP reintroduced `managed-auth.test.mjs` and
`portal-lifecycle.test.mjs` as byte-identical duplicates of their `.legacy.mjs`
archives. They expected the retired JSON setup wizard or static store fallback
and already failed before this work. The duplicates were removed; the preserved
archives and old browser fixture are reference material, not current acceptance
suites. Current auth/lifecycle scenarios remain in routing.test.mjs and
landing-session.test.mjs.

## Live acceptance after deployment

Publish Master rules first, deploy all source files, then test guest/Master/tenant
submissions, request details/statuses/search and both conversion forms. Verify
that payments require a real amount and explicit save, contact enquiries still
work, and merchant login → admin → back to homepage → Logout remains intact.
