# AI98 — Targeted Person Email Discovery, phase 1

## Observed problem
Latest measured campaign `cmwntlszx0001ep3l6o2ex7o4` finished with
five Discovery calls, ten Source calls, 23 public-page inspections and
zero independently attributable emails. Thirteen inspected pages were
readable but did not contain acceptable named-email proof. Broad person
biography searches are not optimized for finding official contact records.

## Change
The existing `personSourceSearchQuery` now prioritizes the **exact quoted
person name**, then public email/contact intent and the existing mapped
profession. No new HTTP adapter, API key, AI provider call, result type,
endpoint, queue stage, quota or approval is introduced.

Gemini 3's existing source-targeted extraction instructions prioritize
a provider-cited public document that *independently* identifies the person
and explicitly publishes a named Email field. The result remains a source
**hint**, not an email address, contact record, outreach permission, or
proof of mailbox control. The unchanged trusted reader, robots/DNS/SSRF
checks, exact-person classifier and separate readback still decide whether
any evidence can be reviewed.

## Why not Google/Brave yet?
An extra search endpoint introduces new billing, approval, retry and evidence
contracts. First evaluate a different query with the *existing* approved
Tavily Basic + Gemini 3 search and its immutable price envelope. Google
public result scraping and automated SERP extraction are not introduced.
Any independently sourced search API is a separately reviewed follow-up.

## Offline replay and evaluation
`test/ai98-targeted-person-email-query.test.js` compares old and new
query shapes across synthetic named observations without network access.
This validates deterministic criteria, bounded request configuration,
exact-person identity and no guessed domain/email, **not yield**.

Before a paid A/B, capture a consented, owner-scoped evaluation snapshot
of prior observations and their evidence statuses. Compare the same target
identities with the previous query and the new query only under separate
explicitly approved per-arm spending, honoring immutable source job
approvals and no-replay. Measure:
- Cited independent exact-person documents per call.
- Public pages accessed vs rejected by robots and HTTP.
- Named email evidence accepted for human review.
- Total approved worst-case costs and run duration.
Do not infer outcome improvement from query-text tests alone.

## Compatibility and safety
Existing plan materialization is advisory; at claim time the source executor
derives the actual approved query from the persisted named observation.
The immutable observation fingerprints, job idempotency, lease, auth and
conservative settlement rules are unchanged. No schema migration. Existing
completed or queued jobs are not rewritten. No provider calls or production
data changes were executed to produce this PR.
