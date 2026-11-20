# AI98 — Campaign-local source failure feedback (P1)

## Dependency
This PR is stacked on #188 (bounded, citation-only source URL ordering).
Merge #188 first. No independent deployment of this branch while #188 is
still under review.

## Confirmed production gap
The latest large run had 39 settled Source jobs, 0 VERIFIED evidence
and 51 robots-denied URLs among 95 attempted public URLs. The existing
`repeatedUnavailableSourceDomains` helper expects rows with
`status=SOURCE_UNAVAILABLE` and a retained source URL, while actual
settled jobs persist `status=COMPLETED` and a bounded
`lastErrorCode`. Failed URL hosts are not available in the job record,
so domain-level blacklist learning cannot be implemented without
a separate retention/security/domain-contract decision.

The source selector from #185 already adjusts priority by
reason and campaign-local verified yield. It treats all
`COMPLETED` jobs alike, including independently verified
`SOURCE_ALL_PAGES_UNAVAILABLE` and accessible pages without
named email. This leaves a valuable, already-persisted operational
signal unused.

## Change
In the **existing** owner-scoped claim transaction, fetch
`lastErrorCode` alongside approved job fields. The immutable
job snapshot remains defined by observation identity, evidence
fingerprint and reason. Never hash, alter, replay or remove
approved jobs based on feedback.

For each reason, examine at most 250 jobs from this campaign/cycle:
- Only terminal `COMPLETED` and `VERIFIED` jobs with at least
  one attempt contribute to the existing sample.
- Preserve the minimum sample of four and previous -5 promotion
  when two or more VERIFIED outcomes exist.
- With zero VERIFIED, keep the existing +5 demotion by default.
- Use a stronger +8 demotion only when at least three independently
  settled jobs and >=75% of terminal jobs from that reason have
  `lastErrorCode=SOURCE_ALL_PAGES_UNAVAILABLE`.
- Other codes, readable no-email, queued, paused, running and
  billing-uncertain outcomes never count as access-failure evidence.

This alters deterministic ordering ONLY. It never rejects or removes
a source job, shortens a user's approved budget, changes a terminal
full-run status or labels an inaccessible host. Ties preserve the
observation-ID ordering. No new network call, provider budget, schema,
endpoint, source host retention, robots bypass, authorization,
independent email attribution, contact acceptance or sending.

## Tests and evaluation
Tests cover source reason ordering under accessible/no-email and
predominantly inaccessible outcomes, low samples, uncertain jobs,
deterministic ties and immutability. Existing claim tests and CI must
stay green. This is an operational heuristic, not an observed
improvement in yield. Measure the next separately approved bounded
run by source reason, unavailable URL count, verified email evidence
and conservative reserved cost.

## Deferred early-stop
A zero-yield run should not be marked COMPLETE while approved,
untouched jobs remain QUEUED. A real early-stop requires a
persisted terminal reason, explicit coordination with the full-run
orchestrator/UI, approval semantics and reconciliation tests.
It is deliberately excluded from this change.
