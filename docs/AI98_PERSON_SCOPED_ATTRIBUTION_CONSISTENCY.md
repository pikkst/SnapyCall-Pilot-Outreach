# AI98 — Person-scoped attribution consistency (P1)

## Root cause
PR #182 made exact, independently verified JSON-LD Person records on a
shared page reviewable. Downstream consumers still rejected any duplicated
source URL: `summarizeQualifiedEmailEvidence`,
`buildQualifiedContactManifest` and manual `acceptReviewedCampaignContact`.
Thus an eligible shared person/email pair could be counted as zero, omitted
from the batch manifest, or rejected at final manual review.

## Contract
Reuses the existing persisted provenance token
`AI98_EXPLICIT_SCOPED_PERSON_EMAIL_ON_SHARED_SOURCE` and
`observationInspectionSource`. A repeated source URL can be accepted for
a particular observation **only** when:
- an exact reviewed person-email status and code are persisted;
- the email is normalized, non-generic and accompanied by a valid SHA-256
  digest and inspection timestamp;
- `personSourceUrl` resolves to the same trusted inspection source, with a
  valid `personSourceVerifiedAt`;
- the proof has precisely the scoped provenance, not generic profile/AI hints.

Qualification and immutable batch manifests require email uniqueness across
the complete campaign snapshot. Shared generic citations and unscoped
observations remain blocked, even when another person on the same page has
valid scoped evidence.

Manual acceptance continues to perform a fresh independent public-page
readback before any DB write. The current owner-scoped transaction locks
membership, campaign, observation and workspace, checks matching name,
source and unchanged digest, and keeps the email uniqueness constraint.
For a scoped proof, a *different person's* Candidate with the same
`expertProfileUrl` is no longer treated as a collision; an identical email
or previously removed identity still fails closed. Unscoped proof retains
its previous conservative email-or-URL collision rule.

No migration, schema change, alternate endpoint, additional AI query,
new permission, automatic contact acceptance or email sending.
Batch remains feature-gated OFF in production.

## Tests
- Exact person-scoped duplicates qualify and enter a deterministic manifest.
- Duplicate email, missing scoped timestamps or unscoped shared pages do not.
- Explicit manual acceptance under shared source requires fresh matching
  digest and locks, never implicit consent or sending.
- Another person's contact on the same URL does not block a valid distinct
  scoped mailbox; email identity collisions continue to fail.

## Next priority (separate scope)
Improve source-job selection using observed successful evidence per
independent domain and failure reason, under the *existing* immutable budget
and retry-safe query contract. Measure qualified evidence per authorized
source-job rather than search volume alone.
