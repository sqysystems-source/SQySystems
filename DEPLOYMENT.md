# Deployment — managed merchant login

## 1. Fill AURA config once, as the agency owner

Edit the `AURA_FIREBASE_CONFIG` block at the top of
`public/js/tenant-config.js`. Paste all six actual web values for
**test-db-f6315** from Firebase Console → Project settings → Your apps.
`authDomain` and `projectId` are prefilled from the project named in your request;
verify them against the Console too. Replace every `PASTE_AURA_...` placeholder.
The precise storage bucket hostname must come from your web config; do not
assume a bucket suffix from the project ID.

This is the only config editing the agency needs to do for AURA. The merchant
will never be asked for these values. They are public web config values, not
service-account JSON or private keys. Never place server secrets in this file.

The code already maps `kostas6603@gmail.com` to AURA and sends its R2/email API
requests to `https://www.sqysystemsdev.org`.

## 2. Check the AURA tenant account

In Firebase **test-db-f6315**:

1. Enable Authentication → Email/Password.
2. Create or reuse the email/password account `kostas6603@gmail.com`.
3. In Firestore, use the Console or a trusted Admin SDK to set
   `users/{THAT_ACCOUNT_AUTH_UID}.role = "admin"`.
4. Keep the existing tenant Firestore rules and indexes. They must allow a
   signed-in user to read their own `users/{uid}` document and allow verified
   admins the existing panel operations. Never permit self-assignment of admin.
5. Add `sqysystems.com`, `www.sqysystems.com` and any exact staging hostname you
   use under Authentication → Settings → Authorized domains.

Use that tenant account's password when testing. It may differ from any old
agency/Master account password. There is no Master sign-in, account creation or
UID requirement in the new merchant flow.

## 3. Deploy Master rules to Master only

The root `firestore.rules` belongs to **sqysystems-faa0e**, not the tenant.
Publish it in the Master Console, or use your installed Firebase CLI:

```sh
firebase deploy --only firestore:rules --project sqysystems-faa0e
```

It preserves owner-only agency profiles and create-only public contact messages.
Client profile create/update can no longer assign/change `tenantStore` or
`storeSlug`; existing profile `role` remains immutable. Legacy connection fields
can stay in old profiles, but they are no longer read by routing. Delete legacy
fields only through trusted agency maintenance if desired.

`store_directory` is client-denied. This release uses the static code registry,
so there is no unauthenticated Firestore directory request and no need to grant
public access to merchant profile documents. The optional Firestore-backed
fallback is not enabled. Do not weaken these rules to recreate the old wizard.

**Do not publish these Master rules to test-db-f6315.** The tenant's existing
product/order/settings rules remain separate and were not changed.

## 4. Keep the tenant backend and bucket CORS in place

The tenant backend is still at `https://www.sqysystemsdev.org`, with `/api/r2`
and `/api/send-email`. Both must accept the agency's exact origin(s), handle
OPTIONS before requiring Bearer auth, and allow `Authorization, Content-Type`.
See `ESHOP_CORS_INSTRUCTIONS.md` for the six-line snippet and bucket settings.

Verify the existing handlers use **test-db-f6315's** Admin SDK to verify tenant
ID tokens and tenant admin role for privileged operations. The new portal sends
tenant tokens, never Master tokens. Keep existing ownership checks, upload
validation and email idempotency. These separate backend files were not supplied
in the latest source and are not patched by this ZIP.

R2 buckets must also allow the agency origin for presigned PUTs. API CORS alone
is not sufficient for direct uploads. Server secrets stay in the tenant's Vercel
environment, not in the agency's browser bundle.

## 5. Deploy the complete agency project

Keep the supplied Vercel settings: Framework **Other**, no build command, Output
Directory **`.`**. Do not set the output directory to `public`, because the root
agency site and config must be served alongside the `/public/` admin assets.
The existing `/customer.html` redirect to `/public/admin.html` is retained.

Upload the whole project. In particular, include the new
`public/js/merchant-session.js` together with the bridge/config changes; do not
update only the HTML or copy an old tenant bridge over it. `npm install` is not
required for production: the runtime uses browser ES modules and the existing
Firebase 10.13.1/CDN imports.

Use the same agency origin for both pages. The redirect from the login modal
is generated relative to the current page's origin; it does not redirect between
`www` and non-`www`. If your hosting has a canonical hostname redirect, apply it
before users log in. Do not pass credentials/tokens through a redirect URL to
work around a hostname change.

Clients can use either:

```text
https://sqysystems.com/public/admin.html
https://sqysystems.com/index.html → Login
```

The navbar's Open Store Admin Panel button is visible before agency login.
General agency customers who are not in the managed store directory keep the
old Master login/profile flow; store merchants are routed directly to tenant
Auth and bypass it.

## 6. Add another managed store

Add a unique entry under `STORE_DIRECTORY` in `public/js/tenant-config.js`:

```js
secondstore: Object.freeze({
    merchantEmails: Object.freeze(['owner@example.com']),
    storeName: 'Second Store',
    storeApiBaseUrl: 'https://second-store.example.com',
    firebaseConfig: Object.freeze({
        apiKey: 'ACTUAL_PUBLIC_WEB_API_KEY',
        authDomain: 'second-store.firebaseapp.com',
        projectId: 'second-store',
        storageBucket: 'ACTUAL_BUCKET_FROM_FIREBASE_CONFIG',
        messagingSenderId: '1234567890',
        appId: '1:1234567890:web:abcdef123456'
    })
}),
```

Replace the example with real values before deployment. Email matching trims
whitespace and ignores case. Each email must occur in exactly one store entry;
ambiguous entries fail closed. To allow another admin for the same tenant, add
their email to that store's merchantEmails and provision their tenant admin role.
Email assignment alone never grants admin permissions.

The registry is deployed code. Adding/removing/reassigning a merchant requires
an agency deployment. To revoke an active merchant immediately, revoke their
admin role in that tenant; its live profile listener locks the workspace.

## 7. Acceptance checks with real projects

- With a fresh tab, open `/public/admin.html`. Only Email and Password are shown.
- Sign in as `kostas6603@gmail.com` with the tenant password. AURA opens without
  a Master login or any configuration prompt. Wrong password allows retry.
- In another fresh tab, use the landing-page Login modal with the same tenant
  credentials. It opens AURA immediately and does not ask for a second password.
- Inspect network requests: Auth uses test-db-f6315; Firestore feature requests
  go to the tenant; R2/email go to www.sqysystemsdev.org with a tenant Bearer token.
- Refresh `/public/admin.html`: the role is checked again and the panel resumes.
- A tenant customer account and an unassigned email cannot open admin features.
- Update a test product, optional brand/subcategory/discount and shipping setting.
  Verify order tabs, analytics, notifications, catalog publish and audit logs.
- Test one media upload/delete, one drive upload/download/delete and a shipment
  email to a test recipient. Confirm correct CORS and backend authorization.
- Remove admin role while the portal is open: it locks and clears its session.
- Log out on desktop and mobile: tenant Auth, displayed data and locator clear.
- Test a normal agency client signup/login/profile edit and a guest contact
  message to confirm the preserved Master website features.
- Keep old store-hosted admin screens removed or redirected to the agency portal
  in the actual e-shop deployment. Moving this UI does not itself remove them.

`npm test` runs the included isolated checks. Firebase emulator, deployed browser
behavior and live R2/Resend testing must be done after adding your real AURA keys.
