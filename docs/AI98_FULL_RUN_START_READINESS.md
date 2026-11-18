# AI98 full-pipeline startup and stage readiness — 2026-11-18

## Confirmed staging smoke root cause

On `pilot.eventnexus.eu`, a 50-request discovery-only approval ran the
original 24 tasks, stored 63 named research observations, and finished without
person-specific email evidence. Read-only SQL confirmed the affected campaign
ended `PARTIAL` with `ResearchCampaignRun=COMPLETED` and **no**
`ResearchFullRun` row, email triage `IDLE`, and 0 source jobs. This is not
a provider outage or a retriable billable failure.

The prior Research screen had an optional full-run checkbox, default false,
and silently sent a discovery-only approval when the source stages were not
enabled. It called the primary button `Approve single run` even though
the user's goal was 100 named, independently evidenced professional emails.
The server's prior `fullRunEnabled` field also omitted three required
discovery executor flags, which could misstate actual stage worker readiness.

## Contract after this change

- The **primary Research start** is always a full pipeline request. It sends
  `fullRun` with explicit public inspection, no automatic billable replay and
  no sending consent. No silent `fullRun` omission is permitted.
- The UI disables the paid approval action if the server does not report every
  actual stage worker gate enabled, and displays the missing workflow stage
  names. No secret environment values are exposed.
- A single shared `fullRunReadiness(env)` now controls the owner-scoped
  approved-run GET, full-run POST authorization and worker startup.
- The API approval response must contain `FULL_RUN_APPROVED` and a persisted
  `fullRun` charter. The UI reflects this instantly, before the next poll.
- Historical discovery-only campaigns remain readable and explicitly say
  **Discovery finished · emails not verified** instead of claiming full research
  completion. They are not silently upgraded under an exhausted, immutable
  discovery approval.

## Activation and limitations

Only enable a full-run in a deliberately approved release after checking all
of the following runtime flags:

```
AI_FULL_RUN_ENABLED=true
AI_PERSON_SOURCE_APPROVAL_ENABLED=true
AI_PERSON_SOURCE_EXECUTOR_ENABLED=true
AI_EMAIL_TRIAGE_ENABLED=true
AI_AGENT_AUTORUN_ENABLED=true
AI_AGENT_RESEARCH_ENABLED=true
AI_AGENT_EXECUTOR_ENABLED=true
```

The separate optional `AI_CONTACT_BATCH_ENABLED` controls user-reviewed
Candidate persistence, not the research run's automatic source lookup. Email
sending is never authorized by these flags. Enabling executor flags can start
**previously approved non-terminal work**, so inspect existing approved-run
and source-job ledgers, uncertain billing leases and user budgets *before*
changing any production environment variable.

The Render connector service metadata does not expose deployed env values, so
flag readiness cannot be asserted from a service configuration lookup.
Confirm from the authenticated, owner-scoped `GET /approved-run` capability
response after deploy, then verify actual worker activity without speculative
AI calls. No full-pipeline E2E, staging flag activation, production deploy,
new billing action or sending is included in this fix.
