# Project studio & agency requests

The existing contact form remains for general enquiries. Hero **Start Your Project**,
all service-card **Discuss a project** buttons and dashboard **Request a project**
open `#projectWizardModal`.

## Flow

1. Select one of four solution tracks.
2. Answer the track-specific questions and optional feature checklist.
3. Define project/domain name, palette or custom colors, aesthetic, timeline and notes.
4. Review the full brief and supply contact details, then send.

Guests can submit without creating an account. Signed-in Master users have their
name/email/company filled and locked to their account, with an optional phone field.
Tenant-only merchants receive editable contact prefill; their tenant UID is never
written as a Master UID. Requests from this context use `uid: null`.

The draft exists only in memory, persists through Back/Continue and closing/reopening
in the same page, and is not stored in localStorage. Changing tracks clears the old
track's subtype, features and scope answers; brand inputs remain. Submission validates
both in shared JavaScript and in Firestore rules. Success appears after the confirmed
write, with its request reference. Double submission while saving is blocked.

## Master document

`project_requests/{generatedId}` stores exactly:

- `uid` (Master Auth UID or null), `clientName`, `clientEmail` (lowercase),
  `clientPhone`, `company`.
- `category` (`websites`, `applications`, `backend`, `design`), `subType`,
  `profession`, `productsOrServices`, `estimatedScale`, `selectedFeatures`.
- `projectName`, `preferredColors`, `aestheticStyle`, `timeline`, `notes`.
- `status: "new"` and `createdAt: serverTimestamp()`.

`preferredColors` combines a selected palette name with optional custom text.
The shared model defines enums and text limits. Optional text is stored as an empty
string, not omitted. No credentials, tenant keys or payment details belong here.

A true Master account link is validated against Auth UID and Auth email in both
the submission service and rules. Guest contact details are self-reported. Authenticated
owners can read requests where `uid` matches their Master UID; an owner query must
filter by `uid`. Public and other clients cannot read another person's brief.

## Agency operations

SQy Admin subscribes to requests only after the existing Master admin/superadmin
check. It displays them newest first in overview and the dedicated Project requests
view. The badge counts all `new` briefs regardless of the active search/filter.

Open a row to inspect all answers and change status among `new`, `in_review`,
`approved`, `archived`. Admin updates change only `status` and a server `updatedAt`;
the original answers and creation time remain immutable. Delete requires confirmation.
Role loss/logout clears the request list, details and subscriptions.

- **Convert to paid order** prefills client email/name and package details including
  project name. It leaves amount blank. A payment record is created only after
  entering an actual amount/date and explicitly saving.
- **Connect e-shop** prefills email and project/store name. Existing store connections
  retain their current name/config. Six Firebase fields and API origin still need
  agency review before saving. A long project name is capped to the store's 80-character
  name limit.

Approval is not payment. Neither conversion action automatically changes a brief's
status, creates a payment or provisions external infrastructure.

No additional Firestore composite index is needed for the admin list: it uses the
existing protected collection subscription and sorts locally.
