# AI98 — source-discovery audit and P1 correction (2026-11-20)

## Scope and evidence
Read-only audit of `main` and production Neon. Latest campaign
`cmwo6wps80001mp3omrc33wdv`: 5 Discovery calls, 10 Source calls,
25 cited public URL inspections, 10 unavailable (including 9 robots
denials), 15 readable without uniquely attributed email, zero VERIFIED.
Source jobs settled: 4 ALTERNATE_EMAIL_SOURCE, 2 PERSON_SOURCE_REQUIRED,
4 SHARED_SOURCE; four more SHARED_SOURCE were queued after the approved
source budget was exhausted. These are campaign-local observations, not
ground truth for unrelated runs.

Prior successful campaign `cmwo36fqy0001gr3kfeqczblo` had 1 VERIFIED
out of 10 Source calls. It used
`AI98_EXPLICIT_NAMED_EMAIL_ON_PUBLIC_PROFILE`, so it did not demonstrate
the scoped multi-person JSON-LD path.

## Audit findings

### P1 — discovery/verification contract mismatch (fixed by this PR)
`research-provider-adapters.js` source-targeted extraction told Gemini
to prefer personally named contact sources and exclude shared/team
pages. However #182 and #184 explicitly permit independently verified,
fully structured multi-Person records on the SAME officially cited
document. Excluding those results before inspection prevents the
stricter validator from evaluating legitimate evidence.

**Change:** revise only source-targeted instructions: official organization
or team page can be a *cited source hint* if provider title/excerpt names
the exact target professional. Generic directories, unattributed shared
inboxes and mere mentions remain disallowed. Keep independent HTML,
robots/DNS/SSRF, explicit mailbox-person mapping, readback/digest and
manual approval requirements unchanged.

### P1 — high reading yield but zero email proof (not fixed by this PR)
15/25 latest URL inspections were readable but had no qualifying named
mailbox proof. A prompt is not enough to make those pages publish
contact data. Inspect allowed structured public HTML and readable team
cards in a separately scoped follow-up after a positive controlled
sample; do not infer by text proximity.

### P1 — access barriers and failed domain quality (not fixed)
9/25 page inspections were rejected by robots. Respect denials; no
scraping bypass. Existing `repeatedUnavailableSourceDomains` already
handles repeated unavailable domains within the campaign. Replacing
search with cross-tenant domain reputation lacks evidence and requires
a separately reviewed privacy/approval contract.

### P2 — measurement
Instrument separate counts for source hint relevance, inspected
official vs third-party evidence, independently qualified source pairs,
and reserved budget per qualification. Reuse existing audit aggregates
rather than raw personal data. Compare the same approved query/model
conditions; do not claim causal yield gains from different populations.

## Security and compatibility
This PR changes only Gemini's **source-targeted prompt**, not general
Discovery, source IDs, URL acceptance, model output schema, query count,
approval scope, immutable budget, retries, job priority, contact creation,
RLS/ownership, no-send restrictions or database schema.

Unit tests pin exact-target-only cited shared-page hints and reject
nonexistent source IDs and off-target persons. This is an offline
contract test, not measured provider yield.

## Release gate
CTO review, exact-HEAD CI, no active paid lease before merge/deploy.
Do not start any billable research automatically. After release, one
separately approved bounded run can compare source types, access errors,
verified email evidence and conservative reserved cost.
