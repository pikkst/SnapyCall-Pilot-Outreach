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
