# AI-98 — Contact discovery agent pipeline and queue contract

## Goal and non-goal

Goal: one user approval, then a transparent bounded pipeline yielding
**reviewable people with a specific independently attributed public email**.
A target of 100 is a *goal*, never a guarantee. A named profile or Gemini
grounding citation is not a verified contact. This document describes the
intended architecture; not every stage has passed live partner E2E. No sending
or Google Sheets sync is part of research authorization.

Non-goal: a free-running multi-agent swarm where every agent independently
calls a paid provider, crawls public sites or retries unknown charges.

## Ownership and existing contracts

One coordinator reuses the existing `ResearchCampaign`,
`ResearchCampaignTask`, `ResearchCampaignRun`,
`ResearchCampaignObservation`, `ResearchRunLease`, source grounding
fields, email-triage fields, review digest, owner-scoped Candidate intake and
spend ledger. Do **not** create a second job queue or duplicate endpoints.

| Stage / agent | Input -> output | Provider requests | Boundary |
| --- | --- | --- | --- |
| 0. Planner | User criteria, source policy, target -> immutable bounded plan | Zero | Owner/workspace auth; configurable budget and BYOK required before paid work |
| 1. Discovery | A task -> cited, deduplicated `UNVERIFIED` observations | One approved paid AI request per task | Fenced task lease, conservative spend, daily quota, workspace pacing |
| 2. Source resolver | Persisted grounding citation -> `SOURCE_HINT/UNRESOLVED/REJECTED` | Bounded HTTPS HEAD, **not AI** | Explicit separate public-request approval, DNS pinning, original citation retained |
| 3. Person evidence | Resolved public URL -> person-specific, independently read page | Bounded public page inspection, **not AI** | SSRF, robots and shared-source checks; no model-generated source acceptance |
| 4. Email attribution | Verified person page -> published named-email evidence or rejection | No AI by default | Exact name/email association; reject directories and generic mailboxes |
| 5. Contact validation | Evidence -> mailbox/contact review eligibility | Strict non-send verification adapter only if configured | Technical status is not permission to contact |
| 6. Review & export | Owner confirms fresh digest -> review-pending Candidate | Zero AI | Workspace transaction, source/collision checks; Sheets optional, Gmail sending disabled |

Each stage persists a terminal outcome or immutable claim before moving on.
A stage may return *zero usable results*. No succeeding stage invents missing
fields. A failed source or address is not recast as a successful contact.

## Dispatch queue policy — implemented in PR #121

1. The existing approved-run worker selects the **least recently updated**
   active run, tie-breaking by ID. This prevents older approvals monopolizing
   dispatch. Every task completion or read-only pacing wait rotates the run.
2. Existing claim lock order stays membership -> campaign -> owner preference
   -> workspace row. Under the locked workspace row, `reserveResearchLease`
   compares PostgreSQL `NOW()` against the **latest persisted**
   `ResearchRunLease.createdAt` in that workspace. It allows at most one
   new lease start every **35 seconds**, regardless of whether the previous
   lease was released or the process restarted.
3. Pacing denial uses `RESEARCH_PACING_WAIT` and an integer
   `retryAfterSeconds`. The entire reserve/claim transaction rolls back.
   **No provider request, new task lease, daily quota or monetary reservation
   is committed.** The approved worker writes `WAITING_RATE_LIMIT` and
   remains `RUNNING` only while its original time, task count and worst-case
   spend caps remain valid; it never reauthorizes a run.
4. Active-lease concurrency and owner-configured daily quotas remain in force.
   A task whose provider outcome or charge is uncertain stays `PAUSED` or
   `RECONCILIATION_REQUIRED`, never an automatic replay. Successful
   no-grounding Gemini responses are already terminal zero-evidence tasks;
   they retain conservative spend without auto-retry.
5. Worker timers are just wake-up hints. No timer owns a task; PostgreSQL
   locks, leases, immutable approvals and spend reservations do. Render Free
   sleeping is **not** equivalent to an always-on scheduler.

**Scope limitation:** the new 35s pacing is *workspace*-scoped, not a
global provider account QPS guarantee across multiple workspaces sharing one
BYOK account. Account-wide pacing and dynamic provider Retry-After/backoff
need a separate, durable owner/provider rate bucket with a clearly proven lock
order and provider policy. Until then keep global concurrency/limits
conservative and do not claim universal provider quota protection.

## Adaptive throughput — next bounded implementation

- Separate rate buckets per owner, provider, model, and work class:
  paid discovery; Google redirect HEAD; public profile inspection.
- Derive refill from documented provider quotas and observed 429 responses.
  Use server-provided `Retry-After` only when trustworthy, with capped
  exponential backoff and small jitter; persist `nextAttemptAt` before
  returning, and retry **only** when the upstream request was proven
  un-dispatched/nonbillable. Never replay a possibly billed request.
- Apply backpressure: no more AI discovery if the downstream source-review
  backlog exceeds an approved threshold; pausing must not destroy approval
  or reorder a partially processed campaign.
- Fairness: round-robin by last dispatch/last update across active campaigns,
  with per-workspace/owner concurrency and budget limits.
- Observable metrics: queue depth and age; available vs in-flight vs paused;
  next eligible attempt time; provider attempts and 429 count; evidence yield
  per paid attempt; cited vs resolved vs named email vs reviewed contacts; USD
  app ledger ceiling vs independently reconciled provider invoice.
- Enforce idempotent execution on all edges, including cancellation, stale
  workspace membership, two browser tabs, expired leases and restart.

## Three-strike quality gate (PR #125)

The existing task commit transaction calculates the current quality streak
from persisted, indexed `ResearchCampaignTask` outcomes; no browser counter,
independent autonomous AI agent, extra provider request, or schema migration.

- A completed task with **zero** normalized, independently cited candidate
  observations increments the consecutive failure count. Both known Gemini
  STOP-terminal failures (`NO_VERIFIABLE_GROUNDING` and
  `NO_USABLE_STRUCTURED_OUTPUT`) count as zero-evidence failures.
- A completed task with one or more accepted provider-cited observations
  resets the counter to zero (this is *source evidence*, not contact/email
  verification).
- After three **contiguous** completed zero-evidence outcomes (indexed task
  order), and only when no unsettled paid task remains, the existing
  membership/campaign lock and lease-fenced write transaction sets the
  campaign status `QUALITY_STOP`. This blocks all further paid claims
  without deleting queued tasks, citations, approvals, or spend history.
  Autonomous run state becomes `PAUSED / QUALITY_STOP`; browser progress
  shows a plain-language explanation and 0/3–3/3 validation failures.
- A gap, paused billable task, stale lease or settlement uncertainty is
  **not** treated as a normal quality retry. Unknown network/billing
  outcomes continue to require immediate manual reconciliation.
- Existing authorized subsequent tasks are independent budgeted AI calls,
  never a replay of a previous billed request. No unbounded retries and no
  automatic new campaign or expansion of approval.

The third strike stops execution; no implicit reset of a stopped campaign.
A new campaign or approval after investigation must be explicitly requested.

## Gemini 3 Flash selection (model migration)

The default displayed model for new Gemini configurations is
`gemini-3-flash-preview`. Existing BYOK users retain their saved model
and encrypted key; changing the exact model is an explicit user action in
**AI Settings**. A switch never creates a campaign, submits a paid provider
call, rewrites previous task results, or reclassifies spend.

The Gemini adapter sends `thinkingConfig.thinkingLevel="minimal"` only
for Gemini 3 Flash Preview (2.5 retains `thinkingBudget=0`). The
provider-grounding-to-candidate provenance contract is unchanged.

**Critical cost boundary:** Google's published Gemini 3 Search Grounding
tariff is per **individual Google search query**, not per grounded prompt
as in Gemini 2.5. Google controls internal query expansion; current
`generateContent` integration has no independently verified hard
per-call search-query cap. Consequently, **Gemini 3 Flash Preview is
selectable but NOT approved for paid research** in the exact-model
server pricing registry. Never reuse the `gemini-2.5-flash` policy or
assume 5,000 monthly free requests for a user's actual account. Research
preflight returns the existing unavailable-pricing gate before any
provider dispatch. A separate reviewed, enforceable query-cost bound
or a redesigned bounded retrieval adapter is required before enabling
paid Gemini 3 discovery. This is intentional protection, not a broken
API-key setup.

Google model and tariff references:
- https://ai.google.dev/gemini-api/docs/models/gemini-3-flash-preview
- https://ai.google.dev/gemini-api/docs/pricing
- https://ai.google.dev/gemini-api/docs/google-search
- https://ai.google.dev/gemini-api/docs/thinking

## Gemini 3 bounded-retrieval architecture — required before paid enablement

The existing `gemini-3-flash-preview` Google Search tool can perform an
unbounded, provider-decided number of billable web-search queries within a
single model invocation. The reported `groundingMetadata.webSearchQueries`
is **post-call** telemetry, not a pre-dispatch guard. Capping output tokens,
asking the prompt to search at most N times, or using an optional Google AI
Studio project spend cap does **not** enforce per-request query cost. Google
documents possible ~10 minute latency and project cap overages.

**Production design (not implemented):**

1. Use an independently priced, capped public search connector or sanctioned
   source feed to fetch at most N evidence records per task; attach immutable
   `sourceProvider`, `sourceId`, canonical URL, title, timestamp, and
   immutable evidence digest. Each provider adapter must enforce **its own**
   documented maximum query count *before request dispatch*, not merely
   inspect provider response counts afterward.
2. Reuse `ResearchCampaignTask` and `ResearchRunLease`: under the same
   owner, campaign, workspace and budget locks, atomically reserve a known
   worst-case spend ceiling for the bounded retrieval and the downstream
   no-tools Gemini text extraction. No separate unlocked parallel queue.
3. Run `gemini-3-flash-preview` **without** `google_search`, using only
   the retrieved, bounded text excerpts as untrusted task input. Preflight a
   model-specific text-only tariff and both input and output token ceilings.
   Do not call the model again to repair missing provenance or malformed
   output unless separately authorized as a new, uniquely priced task.
4. The LLM may nominate names, domains and categories, but **cannot**
   manufacture citation provenance. Accept candidate sources only where
   their IDs/URLs match the immutable retrieval manifest and independently
   verify a named person. Unresolved URLs, unknown titles, generic company
   contacts and source-less model suggestions remain review-only or rejected.
5. Persist the receipt, token usage, provider cost estimate, evidence digest
   and acceptance/rejection outcome on the existing campaign/observation
   contract; settle conservatively. Preserve no-replay and quarantine for any
   uncertain billable operation. Extend existing QUALITY_STOP logic to
   source-quality yield before authorizing further discovery batches.
6. Before any release, prove multi-tab/multi-workspace concurrency,
   reservation idempotency, source/owner isolation, false-URL rejection,
   source freshness, deterministic digest repeatability, retry safety,
   spend reconciliation and authenticated partner UI.

Until all boundaries are verified and a tariff approved, `GET
/api/research-budget` reports `MODEL_PRICING_UNAVAILABLE` for the exact
Gemini 3 model. The owner UI makes that blocker explicit and preserves the
ability to choose an already approved model. **Do not enable Gemini 3
paid discovery by increasing the generic budget or using a loose
post-hoc Google query count.**

## Target-100 strategy

Do not generate 100 nearly identical prompts at once. Start with a bounded
first batch (e.g. a few facets/regions). Persist task outcomes and dedupe
citations. Compare yield (distinct sourced candidates, eventually named
emails) before scheduling further *already authorized* work. Stop when the
approved task/spend ceiling, a safety gate or the target is reached. The
research target and completed emails are separate counts. Exhaustion yields
`PARTIAL`, not fictitious success.

The current planner creates a bounded static task plan and autonomous run
authorization has a maximum of 24 tasks. Dynamic task creation or expanding
that approval is **not** authorized by this change. For a genuine
100-*email*-contact target, next architecture work must add separately
reviewed deterministic task budgeting, source-yield gating and user
authorization before expanding scope.

## Grey staging release gates

- Exact combined PR HEAD tests, TypeScript, PostgreSQL migration/clean-start,
  anonymous staging smoke and actual authenticated partner workspace E2E.
- Confirm no hidden paid request from toggling one/campaign mode, reconnecting
  a Google account, or loading progress.
- Simulate two concurrent paid starts for same workspace; only one may hold
  the pacing window. Test a released lease still counts; test after restart.
- Run a small **explicitly approved** source-backed search, never reissue an
  uncertain billed request; demonstrate 429 wait and UI status.
- Verify pause/resume/stop and source/email claims are scoped to the active
  workspace. No outreach sending without separate approval.
- Avoid enabling paid/autonomous/source/email flags by default.
