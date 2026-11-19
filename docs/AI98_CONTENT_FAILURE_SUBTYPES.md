# AI98 — Read-only content failure subtype telemetry

## Production evidence
The last observed full-run `cmwnwn48q0001fd3kpylcifri` inspected 28 public
source URLs; 8 were categorised as `content` failures. The prior result
contained only the generic `PUBLIC_PAGE_CONTENT_REJECTED` or
`PUBLIC_PAGE_TOO_LARGE` codes, not enough to distinguish whether MIME,
compression, HTTP response status or payload size is actually dominant.

## Implementation
Within the existing trusted public HTTPS reader, a rejected page emits
the same `PUBLIC_PAGE_CONTENT_REJECTED` error *message* but also a fixed
enumerated `contentFailureSubtype` of:
- `mime` — unsupported or invalid text/html/text/plain Content-Type
- `encoding` — non-identity Content-Encoding
- `status` — successful transfer but page response not 200 (e.g. 404)
- `size` — already supported `PUBLIC_PAGE_TOO_LARGE`
- `other` — any older or unknown trusted content error

These counters are added as
`AuditEvent.metadata.sourceInspection.contentFailures` under the existing
fenced source-job settlement. The histogram must sum exactly to
`accessFailures.content`, with max three attempts and strict enumerated
keys and integer bounds. No raw response headers, URLs, body text, names
or addresses are added to telemetry. Historical audit events without
`contentFailures` remain valid read-only records.

## Security and compatibility
There is **no** relaxation of MIME, compression, transport, size or robots
restrictions. This work does not automatically decompress compressed data;
doing so before knowing which types occur would risk introducing decompression
bombs or unbounded memory usage. No new requests, API contract, database
migration, provider call, budget approval or retry path.

## Measurement / release
After exact-head CI and release approval, use one separately authorised
bounded test to collect the new histogram. Fix only the observed dominant
subtype (for example bounded streaming decompression if `encoding` is
dominant), preserving SSRF/robots and strict email proof.
No automatic full-run or contact acceptance is enabled by this PR.
