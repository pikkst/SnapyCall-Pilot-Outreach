# AI98 — continuation dispatch and explicit public email-link evidence

## Incident and root cause

Campaign `cmwmvd87u0001h23kpp7r4pio` completed 50 discovery calls and
25 initial source calls. The immutable first source approval became
`PARTIAL_BUDGET` and a 15-call `ResearchPersonSourceCycle` was created
with a matching job snapshot. No continuation call was started.

In `claimPersonSourceJob` the selected `approval` can be either the
original `ResearchPersonSourceApproval` or a continuation
`ResearchPersonSourceCycle`. The claim code always wrote the counter
to `ResearchPersonSourceApproval`, even for continuation IDs, so its
CAS matched zero rows, rolled back the lease/budget transaction and
never dispatched a provider call.

## Fix

The claim now uses the same table as the active authorization, with
identical CAS bounds, workspace ownership, campaign locking,
idempotency, price and quota reservations. It updates the original
approval only for cycle zero and `ResearchPersonSourceCycle` for later
cycles. The previous authorization remains immutable.

No new API, migration, funding, retry, worker or permission is created.

## Public person-email evidence improvement

The existing bounded public HTML reader previously stripped all anchor
attributes, so a public `<a href="mailto:jane@example.org">Email</a>`
would be reduced to `Email` without the address. It now renders only
**explicitly labeled** literal `mailto:` links into the inspected
plaintext as `Email: jane@example.org`. This is one additional
*publicly published* source format, not an inferred email address.

Existing independent HTTPS fetch, SSRF DNS pinning, robots/redirect
rejection, maximum payload, precise person-name/email association,
shared URL collision, human review and sending-disabled fences remain
unchanged. Hidden scripts, unlabeled anchors and querystring mailto
links cannot be promoted. If multiple addresses are present, evidence
still fails closed.

## Verification and next scope

- Counter path regression tests assert that the original approval never
  changes when a continuation cycle is claimed.
- Public-reader tests distinguish visible labeled links from scripts,
  generic links, and unsafe links.
- Existing domain/HTTP smoke and CI must pass on exact PR HEAD.

The next incremental enhancement should discover a bounded set of
**official, independently attributable** person/contact pages under
the existing source approval. That requires separate persisted
source-attribution contracts and tests; do not silently fetch arbitrary
cross-domain suggestions or infer email ownership. Optional paid email
finder APIs require explicit pricing, approval, tenant scopes, provider
credential isolation, and GDPR/legal-basis review before integration.

The historical STOPPED campaign must not be restarted, re-billed,
reconciled or edited by this PR. No live paid AI calls are needed.
