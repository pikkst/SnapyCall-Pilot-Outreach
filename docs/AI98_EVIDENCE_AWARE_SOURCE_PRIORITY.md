# AI98 — Evidence-aware source job prioritization (P1)

## Evidence and problem
In the five most recent Neon campaigns (2026-11-19/20), terminal jobs
by *reason* include 28 completed and 1 verified ALTERNATE_EMAIL_SOURCE,
20 completed PERSON_SOURCE_REQUIRED, and 1 completed SHARED_SOURCE.
35 shared-source jobs remain QUEUED across these campaigns. These counts
describe **different** campaigns, not a valid pooled performance estimate.
The previously shipped source executor has fixed reason-tier ordering and
would dispatch ALT before REQUIRED regardless of the same campaign's
settled outcomes.

## Small scoped change
Use the same approved, immutable snapshot of jobs **already fetched inside
the membership/campaign-locked claim transaction**. Only jobs with
`status=COMPLETED` or `VERIFIED` and `attempts>=1` contribute evidence
to their *reason* group. Do not use PAUSED, RUNNING, merely QUEUED,
provider-cited URL counts or model-generated candidate scores.

Keep the existing tiers:
- ALTERNATE_EMAIL_SOURCE (rank 0)
- PERSON_SOURCE_REQUIRED (rank 4)
- SHARED_SOURCE (rank 8)

With at least four settled jobs of the SAME reason in the SAME campaign:
- two or more independently VERIFIED jobs: rank adjustment -5
- zero VERIFIED jobs: rank adjustment +5
- otherwise, no adjustment.

The minimum sample is only an operational safeguard, **not** statistical
proof of a higher conversion rate. The policy stays bounded and conservative
and should be measured against a fixed baseline before broader rollout.
It is deterministic, O(250), ties break by observation ID, and does not
remove queued jobs or modify the persisted order, immutable approval
manifest, source fingerprint, per-owner cap, consent requirements,
leases, reservation, retries, source URLs or provider call count.

Because every claim recomputes the ranking from the currently persisted
cycle's jobs under the same locked transaction, it can adapt after a
completed approved call without changing authorization. If there is too
little evidence, the old priority policy is retained.

## Deliberate limitations
This P1 deliberately **does not invent domain authority scores**.
Existing `repeatedUnavailableSourceDomains` already implements a
campaign-local repeated-unavailability filter during provider result
inspection. That is not a domain success-rate oracle. Domain/organization
identity is not stable enough in current person-source jobs to introduce
unvalidated cross-workspace reputation. Future extensions require
privacy-scoped, source-outcome-grounded telemetry and a measured benefit.

## Measurement and release gate
Unit tests cover cold start, settled success/failure, low sample,
nonterminal/uncertain billing, stable tie breaks and no replay.
Exact-HEAD GitHub CI, app CI and staging read-only smoke must pass.
No paid research or production data mutation is performed by these tests.
After separately approved deployment and bounded campaign, measure
`VERIFIED / paid source jobs`, failures, and conservative committed
cost by reason. Compare with the same query limit and provider model;
do not claim causality from unrelated candidate samples.
