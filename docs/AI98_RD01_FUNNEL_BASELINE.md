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
| Qualified evidence | `summarizeQualifiedEmailEvidence()` | `null`/unknown above the existing 250-row contract or with incomplete data. |
| Human-accepted contacts | none in `ResearchContactBatchItem` | Current states are review-pending/unresolved; report unknown unless a separate accepted-state contract is supplied. |

Access-failure categories come only from `AuditEvent.metadata.sourceInspection.accessFailures`; absent historical metadata is unknown, not zero. Legacy and current reason codes remain separate.

Unknown spend is never treated as zero. The report separates `knownChargedCents`, `unknownReservationCount`, and `totalChargedCents`; the last is null when any reservation is unknown.

Snapshots require validated CUID-shaped `workspaceId` and `ownerId` values. The caller must obtain the snapshot after existing membership and campaign authorization checks.

Stage counts have different units and must not be summed. Source hints, observations, qualified evidence, accepted contacts, and send eligibility remain separate outcomes. No names, emails, URLs, payloads, or exception text are emitted.

## Root-cause table

| Finding | Classification | Limitation |
|---|---|---|
| Source-job failure reasons are persisted | Confirmed contract | Historical meanings vary. |
| Current access/readability outcomes are measurable | Confirmed contract | Legacy audit metadata may be absent. |
| Qualified evidence is distinct from accepted contacts | Confirmed contract | Truncated snapshots are unknown. |
| Parser false negatives are the primary loss | Hypothesis | Requires RD-02 labeled fixtures. |

## Reproducible synthetic result

The test fixture produces 2 discovery calls, 1 observation, 1 planned/attempted/completed source job, 1 cited URL, 3 URL attempts from persisted source-inspection metadata, 1 readable inspection, 1 named-email evidence row, 1 qualified-evidence row, unknown accepted contacts, unknown access categories, and no known settled cost. It is synthetic, not production data.
