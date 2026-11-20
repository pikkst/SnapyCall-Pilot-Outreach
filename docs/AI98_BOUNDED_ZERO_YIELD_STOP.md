# AI98 — Bounded zero-yield paid source stop (P1)

## Why
The production run `cmwobfiis0001j83nxljoymqj` started 39 Source calls,
read 95 public URL hints and yielded zero qualified person-email evidence.
The approved spending limit is a ceiling, not a requirement to exhaust
every authorized job when repeated trustworthy negative signals indicate
poor yield. Ending a run must never misrepresent queued work as completed
or replay an already billed request.

## Contract
Only during `SOURCE_RUNNING`, after at least 12 separately settled
source jobs with `status=COMPLETED`, `attempts=1`, no pending
`proposedSourceUrl` and a known negative `lastErrorCode`, the controller
may stop **future** approved source claims if the independently recomputed
qualified email evidence count is exactly zero.

The presence of a `QUEUED` row is insufficient. The controller shares
the continuation-cycle's immutable observation fingerprint, candidate
linkage, live person-source and email-inspection eligibility predicate,
and also checks an active first approval or cycle, approved time window,
per-call amount and remaining full-run budget. Fully exhausted or stale
queues follow their ordinary terminal/reconciliation path rather than
being falsely reported as cost-saving early stops.

The full-run stage worker executes the decision under the same
owner membership -> campaign row lock ordering used by the source-job
claim, after checking that neither RUNNING nor PAUSED jobs exist and
no pending proposed proof or manual-review state remains. The same
transaction changes any active initial approval and continuation
cycles to `QUALITY_STOP`, changes the full-run state to `PARTIAL`,
sets `lastCode=SOURCE_ZERO_YIELD_EARLY_STOP`, and records a bounded
audit event. No queued jobs are deleted, retroactively completed,
relabelled, or charged. A restarted worker sees `PARTIAL` and cannot
resume an old immutable full-run approval or automatically replay
provider calls. New work requires a new explicit campaign/approval.

No early stop is performed for:
- fewer than 12 settled negative results, any qualified email evidence,
  unknown/mixed terminal state, pending proof, RUNNING/PAUSED jobs or
  owner membership revocation;
- uncertain billing/reconciliation, expired authorization or source
  approval mismatch.

The UI distinguishes the specific cost-saving stop from generic
PARTIAL/budget exhaustion, explains that remaining jobs were unattempted
and preserves findings review. Status is **not** READY_FOR_REVIEW,
COMPLETED or a successful contact discovery.

## Guarantees
No changes to the provider adapter, budget, source lease/token, retries,
robots/DNS/SSRF, independent name-email readback, Candidate acceptance,
batch activation or sending. This does not promise any contact yield;
the objective is to avoid repeated zero-yield spending.

## Release and tests
Exact-HEAD CI and CTO review are mandatory. Tests exercise the
controller handoff, owner-scoped atomic commit, insufficient sample,
reconciliation/leased work, pending proof, changed observation evidence,
budget exhaustion and positive evidence. An isolated GitHub Actions
PostgreSQL service runs actual Prisma migrations and validates initial
and continuation claim fences, idempotent concurrent stop calls and the
stop-versus-paid-claim membership/row-lock race.
Deploy only when no active paid leases exist, then verify explicit
terminal status and cost with a separately approved bounded smoke run.
