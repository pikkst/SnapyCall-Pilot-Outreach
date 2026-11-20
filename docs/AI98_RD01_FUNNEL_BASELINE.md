# AI98 RD-01 evidence funnel baseline

Read-only deterministic diagnostic over an already authorized workspace/owner-scoped persisted snapshot. It performs no provider calls, page reads, writes, migrations, contact acceptance, or sending.

## Metric contract

| Metric | Persisted source | Semantics |
|---|---|---|
| Discovery calls | `ResearchCampaignRun.startedTasks` | Calls started; unknown when the run row is absent. |
| Distinct professionals | `ResearchCampaignObservation.name + category` | A bounded identity proxy; namesake collision risk remains. |
| Observations | `ResearchCampaignObservation` | Persisted rows. |
| Source jobs | `ResearchPersonSourceJob` | Planned, attempted, and completed are separate counts. |
| Provider-cited URLs | `ResearchPersonSourceJob.proposedSourceUrl` | Distinct non-empty URLs; not proof. |
| URL inspection attempts | `AuditEvent.metadata.sourceInspection.attempted` | Actual bounded URL attempts; terminal observations are not substituted. |
| Readable pages | `emailTriageStatus` | Current `REVIEW_REQUIRED` and `NO_EMAIL` outcomes only. |
| Qualified evidence | `summarizeQualifiedEmailEvidence()` | `null`/unknown without completeness proof, above the existing 250-row contract, or with incomplete data. |
| Review required | `emailTriageStatus` | All `REVIEW_REQUIRED` rows; separate from named-email evidence. |
| Named email evidence | exact status + `NAMED_EMAIL_EVIDENCE_REVIEW_REQUIRED` code | Only rows with both persisted fields. |
| Human-accepted contacts | none in `ResearchContactBatchItem` | Current states are review-pending/unresolved; report unknown unless a separate accepted-state contract is supplied. |

Access-failure categories come only from `AuditEvent.metadata.sourceInspection.accessFailures`; absent historical metadata is unknown, not zero. Legacy and current reason codes remain separate.

Unknown spend is never treated as zero. The report separates `knownChargedCents`, `unknownReservationCount`, and `totalChargedCents`; the last is null when any reservation is unknown.

Snapshots require validated CUID-shaped `workspaceId` and `ownerId` values plus a completeness proof whose returned and total observation counts match. ID shape alone does not prove tenant or campaign row ownership; an authorized loader must establish that boundary before calling this pure reducer.

Stage counts have different units and must not be summed. Source hints, observations, qualified evidence, accepted contacts, and send eligibility remain separate outcomes. No names, emails, URLs, payloads, or exception text are emitted.

## Trusted loader and execution

`loadResearchFunnelSnapshot()` is an internal read-only loader. It validates the
selected campaign ID, locks and checks active owner membership, binds every
campaign query to workspace and owner, and reads under PostgreSQL repeatable
read/read-only transaction semantics. Observation count and bounded rows are
compared to produce the completeness proof; the reducer never infers
completeness from the returned array length alone. Audit events are filtered by
the persisted campaign/workspace metadata and duplicate references are removed
before aggregation. Reservations are restricted to source-job reservation IDs
and the same owner/workspace.

The diagnostic is not a public endpoint. With an explicitly authorized local
or isolated read-only database, run:

```powershell
$env:RESEARCH_WORKSPACE_ID = "<authorized-workspace-id>"
$env:RESEARCH_OWNER_ID = "<authorized-owner-id>"
$env:APP_ENVIRONMENT = "local-read-only"
npm run research:funnel-baseline -- <campaign-id>
```

The command prints aggregate JSON only. A staging audit requires separate
authorization, a least-privilege read-only connection, and an explicitly
documented environment label; it must not be run against shared staging from
this task.

## Root-cause table

| Finding | Classification | Limitation |
|---|---|---|
| Source-job failure reasons are persisted | Confirmed contract | Historical meanings vary. |
| Current access/readability outcomes are measurable | Confirmed contract | Legacy audit metadata may be absent. |
| Qualified evidence is distinct from accepted contacts | Confirmed contract | Truncated snapshots are unknown. |
| Parser false negatives are the primary loss | Hypothesis | Requires RD-02 labeled fixtures. |

## Reproducible synthetic result

The test fixture produces 2 discovery calls, 1 observation, 1 planned/attempted/completed source job, 1 cited URL, 3 URL attempts from persisted source-inspection metadata, 1 readable inspection, 1 named-email evidence row, 1 qualified-evidence row, unknown accepted contacts, unknown access categories, and no known settled cost. It is synthetic, not production data.
