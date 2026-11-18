# AI98 — Autonomous contact acquisition: engineering source of truth

Status: **DESIGN / IN PROGRESS**, 2026-11-18. Owner-approved product direction; implementation and authenticated E2E NOT complete. Related: [issue #98](https://github.com/pikkst/SnapyCall-Pilot-Outreach/issues/98), [#59](https://github.com/pikkst/SnapyCall-Pilot-Outreach/issues/59), PR [#142](https://github.com/pikkst/SnapyCall-Pilot-Outreach/pull/142) and stacked PR [#143](https://github.com/pikkst/SnapyCall-Pilot-Outreach/pull/143).

## 1. Product contract

One click, one pre-approved bounded run. Automatically discover public professional people, resolve person-specific sources, locate publicly attributable professional email evidence, deduplicate and prepare up to **100 qualified contacts** for bulk review. The purpose is to remove human per-person processing, not create another research checklist.

**Non-guarantee:** 100 discoverable people != 100 people with publicly attributable email. Stop transparently when the target is reached, spend/time/source budget is exhausted, or a mandatory approval boundary is encountered. Never fabricate an address, source, provider cost, legal basis or mailbox-deliverability claim.

**Three separate statuses:**
- `QUALIFIED_EVIDENCE`: deterministic machine qualification: name + field + attributable non-generic public work email + acceptable durable source. Does NOT imply human review, delivery validity, consent or send eligibility.
- `CONTACT_ACCEPTED`: existing reviewed Candidate/Contact acceptance with evidence-digest and workspace fencing. Do not conflate with machine-qualified records or silently change this contract.
- `SEND_ELIGIBLE`: separate future legal-basis, recipient-type, sender-authorization, suppression and delivery checks. Never send onboarding automatically from research.

UX target: start once; single always-visible activity window; `qualified/100`, running stage, confirmed update timestamp, `review required` exception count and approved/committed/settled budget. Only exceptions and final batch approval require user action.

## 2. Confirmed repo baseline (inspection on 2026-11-18)

- `server/research-campaign-run-approval.js`: immutable owner/workspace-scoped approved run, spend reserve, task count, pause/reconciliation and no-replay. PR #143 raises a **test-phase 24-call ceiling to 250**, preserving the existing $500 conservative cap. This cap is not a contact target, does not extend an already approved immutable run and does not create extra tasks.
- `server/research-campaign-worker.js`: bounded paid research task execution, not full evidence-to-contact orchestration.
- `server/research-observation-email.js`: individual source inspection, rejection of shared/opaque profile source and explicit person-email classifier.
- `server/research-email-triage-worker.js`: separately approved, durable, read-only bounded public page triage; explicitly **NO Candidate creation** and no AI calls.
- Existing PRs #101 (inspection), #102 (manual acceptance), #115 (source-hint bridge), #141 (triage preflight) merged. PR #142 simplifies research UX; PR #143 is stacked on it, not merged.
- Source ambiguity remains material: prior recorded test had 24 observations but only 15 distinct cited URLs. Shared directory URLs are not per-person evidence.
- Existing UI and run count **research tasks/observations**, not qualified email contacts. No measured 100-contact end-to-end result exists.

## 3. Architectural decisions

**Keep Neon/Postgres and existing server-managed controller.** Do not add Temporal/Inngest or duplicate endpoints/models unless a measured failure requires it. Reuse existing workspace auth, transaction/row locking, CandidateEvidence, review digest, source reader, provider routing and budget ledger.

Provider-neutral stages, with capability checks and honest unsupported results:
```text
APPROVED
  -> DISCOVERY (Gemini / OpenAI / Claude via existing BYOK adapter)
  -> PERSON_SOURCE_RESOLUTION (independent direct profile evidence)
  -> PUBLIC_EMAIL_INSPECTION (bounded HTTPS reader and exact name-email attribution)
  -> DEDUP_AND_QUALIFICATION (deterministic, versioned policy)
  -> QUALIFIED_EVIDENCE or EXCEPTION / NO_PUBLIC_EMAIL / RESTRICTED
  -> NEXT PERSON / NEXT SEARCH PARTITION
  -> TARGET_REACHED | PARTIAL_BUDGET | PARTIAL_SOURCES | PAUSED_RECONCILIATION
  -> BULK_REVIEW (later outreach is a separate approval)
```

Workers can process different source candidates concurrently with bounded rate limits; each durable record has a state, policy version, lease, attempt ID, timestamps and provenance. Never depend on the browser remaining open. Polling is read-only, and UI animation never invents completed work. Resume after crash must be idempotent and owner/workspace fenced.

**One approval covers only the action categories and provider-cost ceilings it explicitly describes.** Extending that approval to public-page inspection or new paid search requires a versioned contract and new explicit consent; avoid silently reusing a narrower old approval. Source restrictions (SSRF/DNS/redirects/robots/auth) remain fail-closed.

## 4. Candidate/evidence funnel contract

Each observation remains research-only until an attributable work email has been established. Use canonical normalized URLs for independent person-specific sources; reject opaque redirects, shared directory citations, ambiguous namesakes, generic company mailboxes incorrectly attached to a person, unsupported/private URLs, inferred email patterns and unsupported provider claims.

Proposed machine-qualification decision: `QUALIFIED_EVIDENCE` only when (a) exact named person, (b) occupational field, (c) non-generic email, (d) public source with explicit or independently corroborated attribution, (e) no unresolved identity/email collision, (f) durable digest/source and timestamp, and (g) source and policy scope valid. Store classification reason codes separately from human review and sending status.

Recommended reason codes:
`UNRESOLVED_SOURCE`, `SHARED_DIRECTORY`, `PERSON_SOURCE_FOUND`, `NO_PUBLIC_EMAIL`, `AMBIGUOUS_EMAIL`, `RESTRICTED_SOURCE`, `RATE_LIMIT_WAIT`, `BILLING_UNCERTAIN`, `QUALIFIED_EVIDENCE`, `REVIEW_REQUIRED`, `CONTACT_ACCEPTED`.

**Dedup:** never merge on name alone. Source URL, normalized email, workspace ownership, identity corroboration and collision rules must be checked transactionally; concurrent reviewers/retries cannot double-create a contact. Candidate accept stays behind existing reviewer-confirmed evidence digest until its semantics are deliberately revised.

## 5. Termination and cost algorithm

Campaign input: desired qualified count (default 100), search criteria, enabled provider(s), allowed source types, pre-approved total spend, max billable calls, wall-clock time and page-inspection cap. Target is a goal, not permission to exceed financial caps.

Controller cycle:
1. Claim a durable eligible step under lease and workspace scope.
2. Before any billable provider action: atomic reservation + price envelope + user approval + quota checks.
3. Call provider through an adapter; record invocation identity, reported token/search usage and reconciliation status.
4. Persist immutable evidence, validated structured output, next job or classified terminal reason.
5. Update **qualified-evidence count** from persisted deduplicated qualified records, not from observation counts.
6. Enqueue new discovery/enrichment work while the goal remains unmet AND budgets/authorization/sources/time permit. Do not rerun a possibly-billed call automatically on unknown outcome.
7. At target stop creating new work; reconcile in-flight work; finalize with precise terminal state and actual counts.

`RUN_LIMIT_REACHED` is a resource stop, not success. Run output must distinguish `TARGET_REACHED` from `PARTIAL` and display `qualified`, `accepted` and `sendEligible` separately.

## 6. Provider adapter contract

Reuse existing adapter interfaces and extend only required capabilities:
- `discoverPeople`, `resolvePersonSources`, `extractEvidence` or explicit `UNSUPPORTED_CAPABILITY`.
- For each call persist `provider`, model, adapter version, price-version, request fingerprint, source/citation metadata, token/search usage, charge certainty and normalized error class.
- Gemini grounding, OpenAI web_search and Claude web_search have different citation/usage contracts. Normalize source evidence; do not assume a model-provided source is independently accessible.
- Retry only where safe and proven nonbillable. No silent paid fallback across providers; provider switching needs explicit approved budget/capability policy.
- Treat all remote page and LLM content as untrusted. No executing page instructions.

## 7. Security and operational invariants

- Owner/workspace RLS-equivalent fences on every read/write and post-fetch revalidation; revoke during processing cancels further work and suppresses sensitive response.
- HTTPS SSRF protection, DNS rebinding/redirect revalidation, robots/ToS/access restrictions, bounded response sizes, per-host pacing and source provenance.
- No secrets/PII in logs. Audit transitions and budget; avoid exposing publicly observed email in raw traces.
- Provider timeouts, process crashes, stale leases and unknown billable outcomes become explicit wait/reconciliation states, never free auto replay.
- Email discovery != deliverability != outreach permission. Sending remains OFF in this milestone.

## 8. Delivery slices / checklist

- [x] Verify current API/worker/triage contracts.
- [x] Create single-run UX PR #142 (unmerged; CI verified on prior HEAD).
- [x] Draft expanded approved-call cap PR #143 (unmerged; must verify exact HEAD).
- [ ] **P0** Durable orchestration from discovered observations to person-specific source resolution and existing independent email triage, within appropriately expanded *explicit* approval; persist per-observation checkpoints.
- [ ] **P0** Versioned deterministic qualified-evidence decision and count; no automatic contact insertion under current reviewed Candidate acceptance contract.
- [ ] **P0** Adaptive replenishment until 100 qualified or budget/source/time exhaustion; reuse existing task planner, no uncontrolled generation.
- [ ] **P0** Automatic exception segregation and final bulk review; minimize per-contact clicks.
- [ ] **P1** Provider capabilities for Gemini/OpenAI/Claude with normal error/usage evidence.
- [ ] **P1** Single-run UX: qualified count, activity, final outcome and exception queue; hide diagnostics.
- [ ] **Release** Exact HEAD CI + disposable PostgreSQL/clean start/upgrade tests, authenticated staging smoke, 100 synthetic contacts in one run, 0 paid test calls and no-send proof.

## 9. Required regression matrix

At least: 100 synthetic valid named-email fixtures, shared URL for 5 people, opaque Gemini source hint and independent resolution, name collision, generic mailbox, missing email, private/robots-blocked source, provider 429/5xx, billable timeout/uncertain charge, cost cap, no new consent scope, stale lease recovery, process restart, concurrent duplicate, workspace switch/revocation, mobile polling/reduced motion, and no send. Assert no false `CONTACT_ACCEPTED` or `SEND_ELIGIBLE`.

## 10. Current blockers and next engineer handoff

1. **Structural:** current controller stops on task limit and existing planner is discovery-oriented. Merely raising 24→250 does not generate new person-specific work, and does not solve 100-email target.
2. **Source ambiguity:** email triage correctly rejects shared directory/opaque sources; need a source-resolution job producing independently inspectable person pages before triage.
3. **Review semantics:** existing contact acceptance requires individual digest review; bulk/machine-qualified output needs its own contract before any automatic persistence change.
4. **Approval:** old one-run approval is paid discovery only, public email-triage approval separate. One-launch scope must be versioned and security-reviewed.
5. **Measurement:** no verified actual conversion/cost-per-qualified-contact. Run read-only baseline and synthetic complete E2E before paid production test.

**Next PR**: implement durable `PERSON_SOURCE_RESOLUTION -> EMAIL_EVIDENCE` handoff using existing tables/adapters and scoped endpoints; test source ambiguity + idempotence + auth + crash/restart. Do not merge/deploy or run paid providers without explicit approval. Record each completed slice and exact commit/CI evidence in this document.
