# AI98 — one human checkpoint: Confirm contact list

## User contract

The user configures a bounded research campaign once. Within its immutable
approval, existing workers automatically perform discovery, public email
inspection, bounded person-source enrichment and continuation cycles.
The normal first human intervention after launch is **Confirm contact list**.

The browser now automatically loads the **owner-scoped, read-only**
qualified-contact manifest when both the full-run stage and the discovery
campaign are terminal. It does not call AI, increase a quota, accept contacts,
replay paid jobs, or send any messages.

The review UI shows every selected name, email, public source and exact
manifest. The human checks a confirmation checkbox and invokes the existing
`qualified-contacts/approve-batch` endpoint with an immutable hash.
The downstream contact batch is still review-pending and **cannot send**.
No auto-accept or automatic outreach was added.

If the result contains zero independently verified public person/email pairs,
the UI states that there is no list to confirm. The user is not asked to
approve empty or invented contact data.

## Server-side stage fence

`readQualifiedContactManifest` and `approveQualifiedContactBatch` now
check the linked full-run. For active stages, STOPPED or NEEDS_REVIEW the
final-list endpoint returns `FULL_RUN_LIST_NOT_READY`. A full-run must
be in READY_FOR_REVIEW, PARTIAL or COMPLETED; the campaign itself must also
have terminal discovery. A campaign with no full-run preserves its legacy
review behavior.

The approval check is inside the original transaction after the campaign
row lock, before creation of a batch or items, and also fences owner/workspace
drift. Browser state cannot bypass it.

## Operational exception semantics

The user is not normally asked to restart stages or approve an intermediate
source cycle. A genuinely uncertain billable call, lost membership, invalid
manifest or exhausted authorization still **fails closed** and may require
operator reconciliation. It must never be auto-retried in order to satisfy the
one-click UX goal.

## Evidence quality improvements

- The source-only Gemini 3 prompt now prioritizes a single attributable
  public official biography/contact citation over shared directories. The
  model still cannot manufacture an address or certify identity: the
  independent page reader and exact person/email classifier remain the sole
  evidence acceptance path.
- The public-page reader now preserves literal `mailto:` anchors even
  when the visible link text is the **exact same email address**, not just
  `Email` or `E-mail`. Mismatched label/href addresses, generic links,
  scripts and `data-href` are not promoted. This broadens legitimate
  public person-email evidence without changing the independent exact-name
  check or the human review gate.
- The strict public HTML reader's byte cap is raised from 64 KiB to 128 KiB
  because real source inspections hit `PUBLIC_PAGE_TOO_LARGE`. Responses are
  still bounded by declared content-length and streamed byte count. All DNS
  pinning, robots rules, no-redirect, no-script and HTTPS-only restrictions
  are unchanged.
- These are evidence coverage improvements, not a guarantee of usable
  emails or permission to send messages.

## Scope

This PR is stacked on #165 and should only be merged after #165.
No schema migration, new API endpoint, paid email provider or mailbox
validation contract is introduced. The already-stopped campaigns are untouched.
The next quality iteration is bounded discovery of independently attributable
official contact pages, plus measured verified-email yield. It requires
separate evidence/approval contracts rather than unchecked crawling.

## Bounded live-test execution boundary

The existing app already exposes authorized, owner-scoped billable
research actions guarded by BYOK, quotas, price envelope, a monetary
reservation ledger and immutable campaign/run approvals. Do not add a
test-only API or invoke provider APIs outside that backend.

The account owner's permission to make a few paid test calls does not
convey an authenticated session to GitHub, Render or Neon connectors.
Those connectors permit code and database read-only diagnostics but
do not expose an authenticated POST execution channel for the app.
Therefore **no real provider call was dispatched during this change**.

When a trusted authenticated backend execution channel is available,
perform a fresh, bounded 1–2-request probe against the approved
pipeline, verifying: returned exact person citations, independent
inspectable source, publicly labeled named email, duplicate exclusions,
app ledger settled balance and provider billing evidence. Record
reservation ceiling *before* paid dispatch, never retry an uncertain
provider call, and preserve STOPPED campaigns and sendingDisabled.
Do not equate monetary reservations with actual upstream invoices.
