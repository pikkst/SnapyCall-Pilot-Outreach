# AI98 stage work progress (read-only)

The existing `GET /api/research-campaigns/:id/approved-run` now returns
`stageProgress` alongside its persisted server-derived `timing` object.
No new API, migration, background worker, billable call or permission is added.

| Stage | Numerator | Denominator | Interpretation |
|---|---|---|---|
| Discovery | Persisted `ResearchCampaignRun.startedTasks` | Immutable `ResearchFullRun.maxDiscoveryCalls` | Approved provider calls started, **not** a time estimate |
| Email inspection | Terminal email inspection outcomes (REVIEW_REQUIRED, NO_EMAIL, BLOCKED, UNCERTAIN) | All persisted campaign observations | Distinct observations already dispositioned; CHECKING/UNCHECKED are pending |
| Source preparation | 1 after source preparation timing transition is persisted; otherwise 0 | 1 | Binary gate, not a duration guess |
| Source enrichment | Initial source approval `startedCalls` + every persisted continuation cycle's `startedCalls` | Immutable full-run `maxSourceCalls` | Cumulative approved source calls started across cycles |

For source enrichment, the cumulative value does **not** reset to zero
when a continuation cycle begins; the API also reports the number of
created continuation cycles. Source jobs awaiting independent HTML
inspection do not count as verified contacts merely because an AI call
was started.

The UI shows each stage's elapsed time, work count and small progress
bar, labeled by the exact work unit. The green completed state is
derived from terminal stage timing, not a fabricated percentage. A
stage may complete having consumed fewer than the maximum approved
calls; the numerator is shown honestly, and a filled bar indicates
the stage ended, not that every optional budgeted call was used.

The endpoint keeps the existing owner/workspace guard and no-store
response. Counts are aggregated by the campaign ID after workspace
authorization. It reveals no person-level PII, provider response,
unsettled budget, token or contact credential. The existing six-second
read-only polling cycle refreshes it.

Known limitations: source call utilization is not a forecast of
remaining wall-clock time or a count of individually verified emails.
Email inspection work counts are based on terminal observation statuses
and may include blocked/uninspectable profiles; they must never be
presented as verified addresses. No ETA is emitted.
