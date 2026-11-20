# AI98 RD-01 evidence funnel baseline

This is a read-only, deterministic diagnostic over an already authorized,
workspace/owner-scoped persisted snapshot. It performs no provider calls, page
reads, writes, migrations, contact acceptance, or sending.

## Metric contract

| Metric | Unit / denominator | Persisted source | Reconstructable |
|---|---|---|---|
| Discovery calls | calls started / approved discovery ceiling when supplied | `ResearchCampaignRun.startedTasks` | yes when run row is present |
| Distinct professionals | unique persisted `name + category` pairs / observations | `ResearchCampaignObservation` | yes; namesakes remain distinct only when category differs |
| Observations | rows / none | `ResearchCampaignObservation` | yes |
| Source jobs | planned, attempted (`attempts > 0`), completed / job rows | `ResearchPersonSourceJob` | yes |
| Provider-cited URLs | distinct non-empty proposed URLs / attempted jobs | `ResearchPersonSourceJob.proposedSourceUrl` | yes; this is not proof |
| Inspection attempts | terminal email triage outcomes / observations | `emailTriageStatus` | yes |
| Readable pages | `REVIEW_REQUIRED` or `NO_EMAIL` / terminal inspections | `emailTriageStatus` | yes for current semantics; legacy meanings remain separate |
| Named email evidence | rows with named-email review code / inspections | `emailTriageCode` | yes as detected evidence, not acceptance |
| Qualified evidence | strict deterministic person-email evidence / detected evidence | `summarizeQualifiedEmailEvidence()` and observation fields | only for complete ≤250-row snapshots |
| Human-accepted contacts | reviewed batch items / qualified evidence | `ResearchContactBatchItem` | yes when scoped rows are supplied |

Access failure categories are reconstructed only from
`AuditEvent.metadata.sourceInspection.accessFailures` and are reported as
unknown when historical metadata is absent. Legacy and current reason-code
counts are kept in separate maps (`sourceJobs`, `inspection`, and audit
actions). Unknown or unreconciled spend is never treated as zero.

Stage counts intentionally have different units and must not be summed. A
source hint, observation, qualified evidence row, accepted contact, and
send-eligible recipient are separate outcomes. The diagnostic reports no
names, emails, URLs, payloads, or exception text.

## Root-cause table

| Finding | Classification | Diagnostic evidence | Limitation |
|---|---|---|---|
| Source-job failure reasons are persisted | confirmed contract | `ResearchPersonSourceJob.lastErrorCode` | historical code meanings vary |
| Unavailable vs readable inspection outcomes are measurable for current rows | confirmed contract | `emailTriageStatus` and allowlisted audit counters | old rows may lack metadata |
| Qualified evidence is distinct from observations and accepted contacts | confirmed contract | strict qualification summary and batch-item source | a truncated snapshot is unknown |
| Missing access metadata is zero | rejected interpretation | diagnostic returns `unknown` | no historical failure type can be inferred |
| Parser false negatives are the primary loss | hypothesis | requires RD-02 labeled fixtures | RD-01 cannot establish false-negative rates |

## Reproducible synthetic result

The fixture in `test/research-funnel-baseline.test.js` produces: 2 discovery
calls, 1 observation, 1 planned/attempted/completed source job, 1 cited URL,
1 terminal readable inspection, 1 named-email evidence row, 1 qualified
evidence row, 0 accepted contacts, unknown access-failure categories, and
zero known settled cost. The result is a test fixture, not production data.
