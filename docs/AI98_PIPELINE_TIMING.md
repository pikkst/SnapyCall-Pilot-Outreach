# AI98 persisted full-pipeline timers

The existing owner-scoped `GET /api/research-campaigns/:id/approved-run`
now returns optional `timing` and `serverNow` fields without a new route,
provider call, migration, approval, or billable reservation.

Timing uses **server-persisted** `ResearchFullRun.approvedAt` as the run
start and the campaign's append-only `research.full-run.stage.changed`
audit event timestamps as exact stage boundaries:

1. DISCOVERY — paid discovery search.
2. EMAIL_TRIAGE — public person-email inspection.
3. SOURCE_PREPARE — source queue preparation and approval.
4. SOURCE_RUNNING — bounded person-source research, including cycles.

Terminal runs (STOPPED, PARTIAL, READY_FOR_REVIEW, NEEDS_REVIEW,
COMPLETED) freeze their total and current-stage duration at persisted
`ResearchFullRun.updatedAt`. Past finished stages keep their earlier
immutable transition boundaries. Future stages display `Not started`.

The browser anchors its display clock to the server response time and updates
once a second only while the corresponding persisted stage is active.
A refresh or reopening the campaign restores its start/boundary timestamps
without client-side session storage. These are *elapsed durations*, not
predicted ETAs.

Security: the existing owner-scoped campaign lookup runs before the bounded
audit-event lookup; events are further scoped by actor ID, entity ID and
action. Audit payload is reduced to public stage names/time only, not
provider content, names, emails or spend. Invalid/oversized histories yield
`timing: null` rather than fabricated completion data.

This PR is stacked on #163 and must be rebased after #163 merges.
Do not merge or deploy #163 or this PR without explicit authorization.
No paused/stopped campaign is resumed.
