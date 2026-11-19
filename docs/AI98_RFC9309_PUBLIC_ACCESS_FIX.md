# AI98 public-page access: REP rule semantics and UTF-8 headers

## Evidence
2026-11-19 Neoni production campaign `cmwnqsxnl0001gc3l9l4a8wlz`
had 28 bounded source page inspections: 11 robots failures, four content
validation failures, 13 readable but lacking independently attributable
person-email evidence. Exact individual robots and MIME causes were not stored;
those counts alone do not prove all blocks are parser defects.

## Root causes verified in source
- The previous `robotsAllows()` returned false on ANY wildcard `*` or
  end-anchor `$` in ANY agent group. Wildcards are valid under RFC 9309,
  so unrelated agent-specific policy could block every SnapyCall URL.
- The response MIME validator rejected the standards-valid quoted
  `charset="utf-8"` despite accepting unquoted `charset=utf-8`.
- The previous robots matching omitted URI query components.

## Contract
- Parse only applicable `SnapyCallResearchPreview` groups; otherwise use
  wildcard agent groups. Evaluate wildcard `*`, terminal `$`, longest
  literal match with Allow winning ties, deterministically without regex
  execution of untrusted policy text.
- Empty Disallow does not deny. Malformed rules in the *selected* groups
  fail closed; wildcard rules in unrelated groups are ignored.
- Evaluate the request path and query, not only pathname.
- Accept only text/plain or text/html with absent or valid UTF-8 charset,
  including quoted UTF-8; reject other or duplicate charset parameters.
- Actual Disallow, unavailable/invalid robots policy, DNS/SSRF restrictions,
  HTTPS pinning, canonical redirect limits, payload size, timeout, authentication,
  email proof requirements and payment/lease rules are unchanged.

## External references
- RFC 9309 https://www.rfc-editor.org/rfc/rfc9309.html
- Google robots interpretation
  https://developers.google.com/crawling/docs/robots-txt/robots-txt-spec
- RFC 9110 HTTP semantics https://www.rfc-editor.org/rfc/rfc9110.html

## Release and measurement
No new endpoints, migrations, background crawlers, budget increases or
provider calls. Exact-HEAD CI and the existing read-only smoke are required.
After deployment, separately authorize a bounded research test and measure
robots and content failure counters. Never assume robots-denied sites are
accessible: a real robots block must continue to prevent the page request.
The independent person-email classifier and human review remain unchanged.
