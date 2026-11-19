# AI98 — Deployment-safe Discovery worker and reconciliation

## Production incident, 2026-11-19

Read-only Neon audit: campaign `cmwnsf76e003bgc3lz3amja2j` had its first
Discovery task claimed at 16:52:00 UTC with a 3-cent reservation. The
120-second lease expired at 16:54:00, no provider result or settlement was
committed, and the full run moved to
`NEEDS_REVIEW / DISCOVERY_APPROVAL_RECONCILIATION_REQUIRED` at 16:54:15.
Render promoted a new process at 16:52:04 UTC, four seconds after claim.
A deployment/shutdown race is a plausible root cause, but the source does
NOT prove whether Tavily or Gemini received the request or charged for it.
The open RESERVED ledger entry must remain untouched pending operator review.

## Runtime change

- `startApprovedCampaignWorker().stop()` is now an awaitable drain:
  synchronously stops additional timer ticks and returns the in-flight
  `tickApprovedCampaignRun` promise (or resolved promise if idle).
- The server's SIGTERM/SIGINT shutdown stops all pollers and HTTP intake.
  Prisma is disconnected only after the current Discovery tick has fully
  completed its normal fenced task outcome and ledger settlement.
- A provider call receives a durable, sanitized
  `research.campaign.dispatch.intent` audit **before** provider dispatch.
  If its insert fails, provider invocation does not begin. A second
  best-effort `research.campaign.provider.returned` event records when
  the call returned, but its absence does not prove the provider was not
  invoked. Neither event contains prompts, tokens, response bodies, URLs,
  emails or API keys.
- There is no auto-retry, billable replay, forced charge, or task reset.
  External host termination after its graceful shutdown deadline may still
  kill an outstanding paid request; the existing expired lease and reserved
  funds then require manual reconciliation.

## Read-only operator reconciliation

Use the scoped script in an authorized environment with the existing DB
connection. The command is intentionally not exposed to the browser:

```sh
node scripts/research-discovery-reconciliation-check.mjs \
  <campaignId> <workspaceId> <ownerId>
```

This verifies active workspace membership and exact full-run ownership,
then reads up to 25 in-flight/paused Discovery jobs, their existing
reservation audit bindings, and owner-scoped reservation states.

It returns immutable observations only:
- lease expired?
- exactly one reservation trace?
- reservation RESERVED or SETTLED?
- dispatch intent recorded?
- provider response recorded?
- automatic replay allowed? **always false**.

Codes from legacy runs may lack new audit events. Such absence is
**not** evidence that nothing was billed. This inspector does not mutate
the production incident, settle reservations, or restart paid jobs.

Before a separate operator-approved remediation, correlate billing receipts
for both retrieval and LLM providers and the DB lease/ledger proof. If
unknown, retain the conservative reserve and mark the task for manual
review. Existing `skipPausedResearchTask` requires settled conservative
billing and cannot be used to skip the current expired RUNNING task.

## Regression coverage

- SIGTERM with an active provider promise drains until it finishes.
- Further timer callbacks cannot begin another task after stop.
- Idle and repeated stop calls are safe.
- Provider rejection does not create a retry and drains safely.
- Ownership/revocation, stale lease, legacy missing intent,
  ambiguous reservation binding, provider receipt and nonmutation
  are covered in read-only reconciliation tests.

## Release constraints

No DB migration or feature flag. Existing authorization, quota, price,
owner budget and lease-fenced task completion are unchanged.
Exact-HEAD CI, DB smoke and CTO review required before deploy.
No paid full-run should be launched during deployment. For live release,
confirm worker shutdown and first post-deploy health checks; an
in-flight provider call longer than the host's shutdown grace cannot be
guaranteed to drain on a single-instance Render service. A dedicated
worker with explicit orchestration is a separate architectural decision,
not an excuse to replay unsettled paid requests.
