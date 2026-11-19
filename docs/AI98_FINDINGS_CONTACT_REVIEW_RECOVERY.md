# AI98 — Restore saved findings and safe single-contact review

## Production symptom (2026-11-20)
Latest campaign `cmwo36fqy0001gr3kfeqczblo` has 22 cited observations
and one `REVIEW_REQUIRED` named-email evidence record. The qualified
manifest renders the person/email pair, but the user sees:
- `Unable to load findings. No research request was started. Try again.`
- `Batch contact saving is not enabled in this environment.`

## Verified root cause
The existing frontend calls
`GET /api/research-campaigns/:id/observations?workspaceId=:id`
(and optionally `&after=:cursor`). Its Express route used
`z.object({after}).strict().parse(req.query)` and therefore rejected
the legitimate `workspaceId` field **before** the owner-scoped DB query.

## Fix
- Keep the existing endpoint. Share the strict validated query shape
  `{workspaceId, after?}` with the research observation domain.
- Require the query workspace to match `candidateReadScope` (403 if not).
- Keep the existing campaign `id + workspaceId + ownerId` DB filter,
  100-record cursor pagination, `Cache-Control: no-store` and
  workspace-generation stale-response fencing.
- When the batch feature flag is off, present a clear action to load
  the existing per-observation review flow rather than a dead-end warning.
- Fix outdated UI copy claiming `0 verified contacts / Email not checked`
  even when stored public email evidence is already available.

## Contact approval invariants
The manual flow is the existing, explicit two-step action:
1. `POST .../email-evidence` independently refetches a cited public URL;
   a named-email evidence record only becomes `REVIEW_REQUIRED`.
2. Human confirms the exact name-email pair and sends immutable
   `expectedDigest` to `POST .../accept-contact`.
   The server independently reinspects the source, then takes the campaign
   row lock and active membership lock and checks unchanged identity,
   source, digest and email uniqueness before creating a
   `REVIEW_PENDING` Candidate with `sendingEnabled=false`.

No AI/provider spending, background contact creation, mailing or permission
inference is introduced.

## Why not enable AI_CONTACT_BATCH_ENABLED now?
The server flag gates the persistent batch worker and the manifest approval
endpoint. The batch worker includes owner locks, one-use leases, independent
person-email readback and no-replay reconciliation, but enabling it is a
separate operational change with potential mass creation of workspace
Candidates. It is intentionally left **OFF** until an explicit batch
activation approval and deployment smoke/rollback plan. The restored
individual review path is sufficient to process the first evidence-backed
contact safely.

## Verification
- Exact frontend query, cursor, malformed values and unexpected fields
  covered in regression tests.
- Existing contact-intake, batching, isolation and auth tests must remain
  green on the exact PR HEAD.
- No production records, contact batches or feature flags changed.
