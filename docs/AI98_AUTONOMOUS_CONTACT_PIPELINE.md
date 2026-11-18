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
- [x] **P0 first slice** Read-only deterministic qualified-evidence count from persisted named-email triage; reject duplicate email/source, missing digest and shared sources. Shown only when bounded snapshot is reliable. This does NOT perform automatic source resolution, contact insertion or review.
- [ ] **P0 continuation** Versioned durable qualified-evidence persistence and adaptive target-driven orchestrator, with no automatic Candidate insertion under current reviewed acceptance contract.
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

## 11. Implementation checkpoint — 2026-11-18

On PR #143 branch, added `server/research-qualified-evidence.js` and regression tests. Reuses existing canonical observation source selection and computes read-only **email evidence ready for review** counts on the already authorized `GET /api/research-campaigns/:id/email-triage`; central running window displays the count if the bounded snapshot is complete. Duplicated email/source, missing name/category/digest, generic inbox, opaque source and uninspected observations never count. No DB mutation, schema migration, provider call, contact insertion, or send. **This is a measurable funnel foundation, not 100-contact automation.** Next: durable person-specific resolution and email enrichment, then adaptive replenishment and minimal-click bulk review. Exact HEAD CI and full authenticated E2E still required.

## 12. Partial-source triage slice — 2026-11-18, draft PR

**Root cause addressed:** the original `emailTriageSourceReadiness` required *every* campaign observation to have an independently inspectable unique source. A single opaque citation or repeated shared directory URL prevented the whole batch from starting, even if other observations had safe direct person-specific URLs.

**Change:** use the same deterministic canonical-source predicate in read-only preflight and locked approval. Preflight now reports eligible distinct sources versus excluded shared/opaque sources. Strict all-or-nothing approval remains the default; the owner must explicitly confirm excluding uninspectable sources to authorize a partial batch. The approval transaction marks those excluded observations `BLOCKED` with reason code and audit counts; the existing durable worker fetches only remaining unique sources. No extra provider calls, no auto-creation of Candidates, no email-send permission, no implicit new approval. Source evidence stays in campaign records for later person-specific resolution. Existing 250-source limit and 24-hour lease remain.

**Limitations:** this does not itself find alternative source URLs for excluded people, grant one-run authorization across all stages, or guarantee 100 contacts. Follow-up requires safe person-specific discovery with a separately approved provider budget and durable checkpoints. Automated bulk qualification remains separate from human acceptance and send eligibility.

**Release gate:** exact-head CI, PostgreSQL tests, authenticated mobile staging smoke on the approval UI, confirmation that excluded observations are never fetched and source snapshots remain fenced; no merge/deploy without authorization.

## 13. Person-source resolution planning slice — 2026-11-18

**Read-only planning foundation**: `server/research-person-source-plan.js` identifies one bounded *observation-scoped* next-work item for each person needing an independently inspectable source. It reuses the canonical `observationInspectionSource` predicate and counts shared direct URL collisions, opaque/untrusted grounding, previously completed email inspections, in-flight checks and alternate-source needs after `NO_EMAIL`. Namesakes remain distinct research observations; **never merge or promote by name**. A safe counts-only `sourceResolution` projection is exposed via the existing owner-scoped `GET /api/research-campaigns/:id/email-triage`; no personal names, source URLs or generated queries appear in the API projection.

This prepares the next stage's **bounded worklist** without performing any paid AI requests, web fetches, persistence or contact creation. The planned query string is NOT sufficient authorization to dispatch: a future executor must fence current owner/workspace access, snapshot/source binding, provider capability, immutable run budget, lease and exact price envelope before contacting any provider. Source candidates returned by an LLM or retrieval API remain untrusted until an independent, safe source read establishes person-specific attribution. `targetCount` currently measures observations rather than qualified contacts — no change to the terminal contract in this slice.

**Next implementable slice**: a durable, explicitly approved person-source resolution queue with persisted attempts/leases, normalized per-provider search results, independent public-profile inspection and contact-evidence association. Must never reuse a stale/cancelled approval, silently burn budget on no-source retries, or mark `CONTACT_ACCEPTED` from search snippets. Run migrations/test both existing and fresh databases if adding durable queue fields.

**Release evidence:** exact HEAD CI plus authenticated staging GET smoke, privacy and tenant isolation; no merge/deploy or paid calls permitted without explicit authorization.

## 14. Durable source-job persistence slice — 2026-11-18

**Added, draft:** `ResearchPersonSourceJob` Prisma table + additive PostgreSQL migration; observation-scoped `UNIQUE(observationId)`, immutable evidence fingerprint, reason, state, future lease token/expiry, attempts and last error. `enqueuePersonSourceJobs()` is a server-only, **explicit non-billable queue-preparation** operation, not yet exposed as an endpoint or called from the running controller. It uses membership lock → owner/workspace campaign lock → complete bounded observation snapshot → pure source plan → transactional idempotent `createMany(skipDuplicates)`. Changed observation identity/source/triage data against an existing job returns `SOURCE_RESOLUTION_JOB_DRIFT`; no silent binding or requeue after uncertain execution. Audit contains counts only, no PII or source URLs. Existing Candidate/evidence/send and provider/budget contracts unchanged.

**Not yet done:** stage-specific durable provider dispatch authorization, search/retrieval executor, verified person-source persistence, adaptive 100-contact replenishment, user-facing queue start control or authenticated staging E2E. The new table must not be interpreted as permission to execute provider requests. Next PR should use the persisted queue with its own immutable approved cost envelope and the existing owner-scoped reservation, lease, usage reconciliation and safe source validation. No automatic retry of any possibly billed action.

**Release gates:** Prisma schema validation, clean-start migration and upgrade migration, exact-head CI with disposable Postgres, auth/revocation/idempotency tests and no-send assertions. Do not deploy without explicit authorization.

## 15. Immutable person-source stage approval — 2026-11-18

**Draft implementation:** `ResearchPersonSourceApproval` is a distinct, one-per-campaign immutable authorization envelope, with additive migration and a default-disabled, owner-scoped `POST /api/research-campaigns/:id/person-source/approve` gated by `AI_PERSON_SOURCE_APPROVAL_ENABLED=true`. Approval requires explicit `maxCalls`, `maxWorstCaseCents`, `confirmPaidSourceResearch=true` and `confirmNoAutomaticRetry=true`; validates registered server provider/model tariff, bound monetary ceiling, a complete queued job snapshot and fresh observation fingerprints under membership and campaign locks. It freezes provider/model/price version, exact eligible-job snapshot digest and 24-hour expiry, and audits only non-personal run metadata.

**Critical limitation:** this is stage approval persistence **only**: approval does not reserve owner budget, claim jobs, dispatch any API, inspect URLs, create contacts, send emails or authorize an unbounded provider fallback. The next worker MUST enforce the immutable snapshot, source eligibility, membership revocation, quota/owner monthly budget and model-version match again *atomically before each dispatch*, reserve full worst-case spend with existing ledger and never replay uncertain billable calls. Approval cannot be reused for another campaign, tenant, changed source or additional jobs. Feature remains OFF; do not enable without executable contract + authenticated smoke.

**Next:** add stage-safe claim+reservation and terminal settlement against the immutable per-campaign source approval; only then implement provider-specific person-source search, public-page evidence verification and adaptive stage transitions. These remain under issue #98; never conflate `QUALIFIED_EVIDENCE` with `CONTACT_ACCEPTED` or `SEND_ELIGIBLE`.

## 16. Paid source-job atomic claim and fenced execution — 2026-11-18

A source-specific executor is being introduced on top of the existing durable queue and immutable stage approval:

- `claimPersonSourceJob()`: locks workspace membership → campaign → approved manifest; verifies price/model, source fingerprint, time and spend caps, blocks unresolved prior jobs; **atomically** reserves existing owner-wide spend, concurrency lease and daily quota before taking one source-job lease. Every run has a persisted financial reservation ID.
- `runOnePersonSourceJob()`: uses existing BYOK provider routing. Gemini 3 always uses its **approved Tavily Basic + Gemini text-only tariff** rather than accidentally invoking differently billed Google grounding. Outputs are normalized citation-backed proposals only and are not treated as verified persons, emails, accepted contacts or send-eligible recipients.
- `finishPersonSourceJob()`: transactionally fences the job lease and conservatively settles full possible spend. Errors after provider dispatch remain `PAUSED/BILLING_UNCERTAIN` and prohibit another paid claim without explicit reconciliation. Expired leases cannot cause automatic replay.
- `ResearchPersonSourceJob` persists `spendReservationId`, `researchLeaseId` and an unverified `proposedSourceUrl`; the source proposal remains separate from `ResearchCampaignObservation.groundingResolvedUrl` and person-email evidence. Source verification still requires the independent robots/SSRF-protected public-page reader.
- Queue preparation cannot append work after stage approval freezes the manifest.

**Not yet activated:** no public dispatch endpoint, startup worker scheduler or new source-resolution feature flag in this slice. No source proposals are promoted to observed profile proof, no email triage consent is widened, no automatic contact creation or sending. The full 100-verified-email end-to-end goal is **not complete**. Next: verified source binding, automatic authorized email inspection, evidence-qualified deduped collection and goal-driven discovery replenishment under one versioned full-run approval. Do not deploy or run paid providers until exact-HEAD tests, migrations and authenticated smoke pass.

## 17. Independent public-profile evidence for qualified email — 2026-11-18

The source-search stage's one provider-cited URL is **not person attribution**. A new explicitly scoped `confirmPublicInspection: true` consent field is mandatory for `ResearchPersonSourceApproval`, persisted as `publicInspectionAuthorized` (default false for old approvals). A distinct additive migration adds `personSourceUrl`, `personSourceProvenance`, `personSourceVerifiedAt` to the observation.

`verifyPersonSourceProposal()` uses the existing bounded, HTTPS/DNS-pinned, robots-respecting `retrieveCitedPublicPage` reader and deterministic `classifyExplicitPersonEmailPage`. Only one person-specific public page with an explicitly labeled **name + email** and no other mailboxes, independently fetched under valid workspace and approval scope, can qualify as `REVIEW_REQUIRED`. It repeats membership, campaign, immutable source fingerprint, source URL and cross-observation/job collision checks inside a transaction. It atomically stores the verified source URL/provenance/digest/email in the original observation and records a non-PII audit. No Candidate is inserted, no human review is faked, and no mail is sent. `observationInspectionSource` prefers this verified URL only with matching recorded evidence and digest; the existing read-only qualification funnel can now count it.

Unavailable websites are `SOURCE_UNAVAILABLE`; a page without attributable evidence is `SOURCE_NOT_ATTRIBUTABLE`, **not** proof that no public email exists. The worker must try permitted alternate independent sources in a separately bounded stage, never manufacture addresses.

**Still outstanding**: default-OFF scheduling and exact stage control, full-run one-click envelope, adaptive discovery replenishment to qualified-email target, verified-bulk storage semantics, authentic staging/production E2E smoke, source attempts beyond the first and outreach legal-basis gates. Do not call this full pipeline ready.

## 18. Durable source-job runner and safe terminal handling — 2026-11-18

`startPersonSourceWorker()` is now wired into existing server lifecycle and shutdown **only** when `AI_PERSON_SOURCE_EXECUTOR_ENABLED=true` **and** `AI_PERSON_SOURCE_APPROVAL_ENABLED=true`. Both default OFF. A persisted, currently valid, person-source-approved campaign is required for each tick. The worker first verifies a persisted paid-source proposal with the independently authenticated public reader, then considers at most one paid BYOK search under the unchanged lease/budget gates. Restarts can resume a saved source proposal without reissuing its paid search. An uncertain paid call remains `PAUSED` and is never auto-replayed.

`quarantineUnverifiablePersonSource()` preserves ambiguous/shared/boundary-violating source proposals as `SOURCE_REVIEW_REQUIRED`, rather than repeatedly reading them. The stage finalizer distinguishes `COMPLETED` from `PARTIAL_BUDGET`; neither signifies 100 contacts nor send eligibility. One owner-scoped **non-billable queue-preparation API** was added with explicit confirmation. Source-stage paid approval still requires a separate explicit client action at this milestone; one-click cross-stage authorization is the next P0.

Release and test gates: exact-head CI, migration checks, manual auth+workspace isolation, reduced-motion UI smoke, server restart/recovery, and no-send checks. Do not enable paid worker until the complete versioned one-run approval is reviewed; do not conflate qualification with human-reviewed acceptance.
