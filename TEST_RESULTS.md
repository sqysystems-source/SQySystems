# Verification — 17 October 2026

## Result

**55 current isolated tests passed; 0 failed, 0 skipped, 0 cancelled.** Node 24.

Command used for the complete final run:

```sh
node --experimental-vm-modules --test --test-concurrency=1 --test-reporter=tap tests/*.test.mjs
```

The package's `npm test` also targets the current `*.test.mjs` suites.

## New landing scenarios (12)

- Landing login → merchant admin → homepage → reload → merchant admin: only one tenant password login.
- Direct admin login restored on homepage without Master login/profile reads.
- A locator without actual Firebase Auth cannot authorize the homepage.
- Merchant context cannot inherit a simultaneous Master superadmin role or write to Master profiles.
- Ordinary Master account/profile updates remain available.
- Master superadmin role removal hides privileged navigation.
- Homepage Logout clears both Auth sessions, locator, identity and profile/directory listeners.
- Disabled/deleted/missing connection revokes an open homepage merchant session.
- Tenant role removal or routing changes invalidate the merchant view.
- Directory network failure on return fails closed.
- pagehide preserves session while clearing listeners; bfcache pageshow requests a reload.
- A delayed Master profile result cannot replace a subsequent merchant identity.

Existing current suites also cover dynamic routing, tenant-role gates, bad passwords,
provisioning, payments, ticket changes, safe parsing, XSS escaping, static assets,
JavaScript syntax and linking the real local ES-module graph.

## Test scope and old fixtures

The tests execute real service/controller code using controlled DOM/Firebase mocks.
Tenant feature modules are stubbed for initialization checks. No real credentials,
emails, payments, bucket writes or production data were used.

The upload also contained obsolete wizard-era and static-fallback-era suites. They
already failed against the provided managed-portal source. Their original contents
are retained as `managed-auth.legacy.mjs` and `portal-lifecycle.legacy.mjs`, with the
old `fixtures.mjs` and `portal-browser.mjs` as historical references; they are not
current runnable acceptance tests. Current landing/routing lifecycle tests use
`harness.mjs`. Active routing/control-plane assertions were updated for the actual
no-fallback configuration rather than reintroducing a hardcoded AURA mapping.

## Not run

No Chromium binary was available, so no real-browser visual or real bfcache test
was performed. The pagehide/pageshow handlers were exercised in the harness.
Firebase Rules emulator and live Firebase/Vercel/R2/Resend integration tests were
not run. Rules and backend were not changed by this patch.

## Production acceptance

After deploying to the agency project, test the round trip on your canonical
hostname in one tab. Changing between vercel.app, apex and www origins requires
sign-in on the new origin. Also verify homepage Logout and a disabled connection
using a test merchant, then restore its status after the check.
