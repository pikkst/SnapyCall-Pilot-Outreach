# Contact removal and restore — 2026-11-18

## User interaction
Both admin-only legacy candidates and authenticated partner workspace contacts
now have **Remove contact → Confirm remove**, **View removed contacts**, and
**Restore contact** controls in their existing contact tables. Removed contacts
are excluded from the default list; removal and restoration are one-contact
actions (no bulk destructive side effect). The list refresh and mutation
responses are fenced against workspace switches.

## Contract and security
- `DELETE /api/candidates/:id` requires an authenticated scoped session,
  CSRF/origin enforcement and a strict `{ "confirmRemove": true }` body.
- `POST /api/candidates/:id/restore` requires the same scope and
  `{ "confirmRestore": true }`.
- `GET /api/candidates` returns active contacts by default;
  `GET /api/candidates?removed=true` shows only removed contacts.
  Partner requests always use their existing explicit `workspaceId` query.
- The mutation takes an active member lock (or admin legacy identity), then
  locks the exact `Candidate` row with null-safe workspace equality. The
  conditional update and audit are atomic. Repeated remove or restore returns
  an idempotent unchanged result without duplicating audit entries. No PII is
  copied into the audit metadata.

## Data semantics
`Candidate.removedAt` and `removedBy` are additive. Removal is **reversible
deactivation**, not GDPR-style erasure. Existing evidence, mailbox/domain
verification, research observation links, batch review records, drafts and
audit trails are retained. Removed contacts fail qualification, contact
readiness and drafting; existing draft lists exclude their drafts. Direct
profile evidence checks, person-email review and DNS/mailbox persistence
require an active candidate. Restoration clears only removal fields;
it does not certify consent, identity or sending eligibility.

## Release notes
The removal migration must work against both fresh and upgraded Neon schemas.
Verify admin legacy vs Google partner identities, revoked workspace membership,
cross-workspace candidate IDs, multiple browser tabs, removed-contact filtering,
evidence retention, and that no draft or outreach path can act on a removed
contact. No email is sent by these endpoints. Permanent data erasure and its
retention/dependency/legal constraints are a **separate feature**.
