# AI98 — P1 Source Quality Gate (2026-11-20)

## Production audit
Read-only Neon evidence from campaign `cmwobfiis0001j83nxljoymqj`:
10 Discovery, 39 paid source jobs (out of at most 40), 95 cited URL inspections,
56 unavailable (51 robots denials, 2 HTTP, 2 oversized, 1 other),
39 readable without a named person's email and zero VERIFIED.
The terminal `NO_UNATTEMPTED_SOURCE_JOBS` outcome is consistent with 39
persisted finished jobs: there was no remaining eligible job for call 40.
The prior campaign also yielded zero email evidence. Raising the limit
alone does not address evidence quality.

## Confirmed feedback contract gap
`repeatedUnavailableSourceDomains` currently expects persisted rows with
`status=SOURCE_UNAVAILABLE` and `proposedSourceUrl`. Actual source jobs
settle as `COMPLETED` with a reason code and **no selected URL** on failure.
In particular, robots-denied URLs are not stored in job rows. Therefore
the existing exclusion helper cannot derive domain-specific negative
feedback from those jobs. Do not fabricate a domain from AI output,
store raw failed-source URLs in unapproved telemetry, or repurpose an
unavailable status without a database/retention/security review.

## Implemented P1: bounded source hint quality gate
On each *already authorized* source result, the source inspector uses
existing exact-target and provider-citation filters, then ranks at most
five URLs before the existing three-page HTTPS inspection ceiling:
- exact person slug in the URL path: +4;
- contact/team/staff/people/experts/speakers path: +2;
- blog/articles/news/events path: -2;
- all ties retain original provider citation order.

This score is strictly a deterministic URL **inspection order**, not
proof of person-email attribution, domain safety or legal permission.
No uncited URL is introduced, no URL is modified, no robots restriction
is bypassed, and a positive hint does not become a qualified contact.
The existing independent, full-page evidence verifier decides whether
the individual and published email are linked.

## Deferred changes requiring a separate domain contract
- Persistent robots-denial and source-success aggregates without
  collecting personal data or turning provider search hints into facts.
- Campaign early-stop of still-approved paid jobs after sustained zero
  evidence, with explicit terminal reason, approval semantics, controls
  and UI progress agreement. Returning `NO_SOURCE_JOB_READY` while
  QUEUED jobs remain would incorrectly complete the campaign; avoid it.
- Source-selection telemetry by query reason and path class.

## Verification and release
Tests: rank ordering, bounded input, stable cold-start order and
independent public page verification. Exact-HEAD CI and CTO review are
required. No merge, deploy, paid run or production data mutation here.
