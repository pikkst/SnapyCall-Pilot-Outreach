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

## Scope

This PR is stacked on #165 and should only be merged after #165.
No schema migration, new API endpoint, paid email provider or mailbox
validation contract is introduced. The already-stopped campaigns are untouched.
The next quality iteration is bounded discovery of independently attributable
official contact pages, plus measured verified-email yield. It requires
separate evidence/approval contracts rather than unchecked crawling.
