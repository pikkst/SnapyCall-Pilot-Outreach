# AI98 daily quota wait — nonbillable recovery

## Incident (2026-11-18)

The first full-run reached 16 completed discovery tasks, with 59
evidence observations. The daily `ResearchDailyQuota` counters for both
the workspace and user-workspace reached 100/100, including earlier
tests. This exhausted the server-side fixed workspace cap
`RESEARCH_DAILY_WORKSPACE_LIMIT=100` while the new run still had 8
never-attempted queued tasks.

`reserveResearchAttempt()` raised `ResearchQuotaExceeded` inside the
atomic claim transaction; no provider call, monetary reservation, lease
or approved-call allowance could commit in that failed transaction.
Previously, the generic autonomous-worker catch misclassified this
as `RUN_EXECUTION_UNCERTAIN`, paused the discovery approval, and the
full-run stage manager moved to `NEEDS_REVIEW` with
`DISCOVERY_APPROVAL_RECONCILIATION_REQUIRED`.

## Correct behavior

- Handle `ResearchQuotaExceeded` explicitly in the existing approved
  campaign worker, using `finishApprovedRunTask` under the existing
  owner membership and campaign row locks.
- Persist `RUNNING / WAITING_DAILY_QUOTA` only while the same immutable
  approval remains valid, has remaining tasks and worst-case ceiling,
  and there are no unresolved `PAUSED`, `FAILED` or `RUNNING`
  tasks. No new approval or capacity is allocated.
- Subsequent ticks re-evaluate after UTC midnight; the DB continues
  enforcing both quota counters. A waiting run cannot exceed its
  original `expiresAt`. Expired approval is paused without a paid retry.
- Any uncertain task remains a reconciliation stop. Exceptions after
  provider dispatch retain existing fail-closed behavior.
- The previously paused production pilot run is **not automatically
  resumed by this patch**. It remains in `NEEDS_REVIEW` until an
  independently approved recovery reconciles the historical pause.
- Browser `401 Unauthorized` on campaign progress is a separate
  session/authorization problem. Do not change security handling to
  conceal it; investigate independently.

## Release gate

No automatic replay, quota reset, manual DB status mutation, new paid
provider calls, or email sending. Validate the exact PR HEAD in CI,
and use read-only production checks after deployment.

## Pre-start daily capacity warning

The existing authenticated owner-scoped `GET /api/research-campaigns/:id/approved-run`
returns `dailyQuota` only for unstarted campaigns. It reads today's
`ResearchDailyQuota` counters for both the workspace (fixed 100/day)
and the owner's per-workspace daily limit (editable in Settings, up to
100/day). Both discovery and person-source paid searches consume these
counters. The response includes `remaining` and the precise next UTC
midnight in `resetsAt`. No quota reservation occurs during reads.

The Research Start panel warns when
`maxDiscoveryCalls + maxSourceCalls > remaining`, disables the paid
approval action, and offers a button linking to **Settings → My research
limits**. If the workspace's absolute cap is exhausted, adjusting
personal limits cannot unlock it; wait for the UTC reset or reduce the
requested run size. The browser re-fetches capacity immediately before
approval. The existing server-side `approveCampaignRun` also checks
capacity before creating either immutable approval, returning HTTP 409
`DAILY_QUOTA_INSUFFICIENT` if the selected maximum cannot fit.
The actual claim's transaction remains authoritative against races.
This does not increase the 100/day ceiling, bypass auth, spend money,
or grant additional provider calls.

An existing run waiting across UTC midnight remains subject to the
original 24h approval expiry and every existing budget/replay rule.
The existing historical `NEEDS_REVIEW` campaign is not resumed by
this feature.
