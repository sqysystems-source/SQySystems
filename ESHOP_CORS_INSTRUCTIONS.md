# E-shop API CORS — apply separately to each client deployment

Paste these **exact six lines** at the very start of the exported request handler
in BOTH `api/r2.js` and `api/send-email.js`, before method checks, token parsing,
body validation or any early return. They handle preflight as well as headers.

```js
const allowedOrigins = new Set(['https://sqysystems.com', 'https://www.sqysystems.com']); const origin = req.headers.origin;
if (origin && !allowedOrigins.has(origin)) return res.status(403).json({ error: 'Origin not allowed' });
if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
if (req.method === 'OPTIONS') return res.status(204).end();
```

The attached portal uses POST for all its R2 API operations and email dispatch.
Keep these headers on success AND error responses. If the handler already has
CORS/OPTIONS code, replace or reconcile it; do not leave a second wildcard policy
that can overwrite these headers. Add the store's own exact origin(s) to this Set
if its storefront also calls these endpoints from the browser. Add staging or
local portal origins explicitly when needed; never blindly reflect any origin.
No cookies or `credentials: include` are needed; requests carry tenant Bearer tokens.

**CORS does not authorize a merchant.** Keep your existing server verification:

1. Verify `Authorization: Bearer <ID token>` using THIS STORE's Firebase Admin SDK.
   A Master-project token must be rejected (issuer/audience mismatch).
2. Read `users/{decoded.uid}` in THIS STORE's Firestore and require `role === 'admin'`
   before the portal's privileged R2 operations or `order_shipped` emails.
   Preserve any separately validated public/customer flow the endpoint already uses.
3. Derive identity/ownership from the verified token; do not trust a client-supplied
   `tenantId`, project ID, user ID or email as authorization.
4. Continue enforcing file/key ownership, upload bounds and email idempotency.

The backend handler sources were not supplied, so this ZIP does not claim to
have patched or audited their auth checks. Apply the snippet in the actual e-shop
repository and redeploy that Vercel project.

## R2 bucket CORS is separate

Presigned uploads go directly from the portal to R2, so API headers alone are
insufficient. In Cloudflare → R2 → the product-media AND drive buckets → CORS,
merge a rule like the following with existing storefront origins:

```json
[
  {
    "AllowedOrigins": ["https://sqysystems.com", "https://www.sqysystems.com"],
    "AllowedMethods": ["GET", "HEAD", "PUT"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Add any other headers required by your actual signed upload URL; do not forward
the Firebase Authorization header to R2. Public media can retain its existing CDN
URL; private-drive download links remain presigned by the store backend.
