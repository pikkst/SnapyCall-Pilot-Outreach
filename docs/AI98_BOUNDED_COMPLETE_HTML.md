# AI98 — Bounded complete HTML retrieval (P1)

## Evidence and scope
Campaign `cmwnygkip0001jn3klzcbv307` (2026-11-19) inspected 18
provider-cited URL documents. Twelve inspections were unavailable, including
four `PUBLIC_PAGE_TOO_LARGE` outcomes. Six pages were readable but yielded
no independently attributable person/email proof.

The original pinned HTTPS adapter rejected an HTML response as soon as the
response's declared **or received** length exceeded 128 KiB, before the
existing `htmlText`, mailto and JSON-LD Person verification could run.

## Decision
Do not blindly remove the resource cap, truncate HTML and accept a proof
from its prefix, or adopt an unbounded DOM parser. Instead, raise the **full
document** ceiling to 512 KiB while keeping the robots policy and resulting
normalized evidence text at 128 KiB. The transport counts received bytes and
checks Content-Length before buffering, including redirects; every request
is bound to the existing 4-second deadline.

A full document below the new ceiling undergoes unchanged:
- robots authorization per destination URL;
- pinned public DNS, HTTPS and one canonical redirect;
- supported UTF-8 text MIME and identity Content-Encoding only;
- full-document HTML-to-text, one named mailto and schema.org Person
  extraction with the unchanged strict matching and readback contracts;
- 128 KiB maximum normalized text, regardless of raw document size.

Any raw response exceeding 512 KiB, or producing more than 128 KiB
normalized text, fails closed as `PUBLIC_PAGE_TOO_LARGE`. A partial body
is never returned for verification. Source diagnostics retain the existing
`contentFailures.size` category. No new provider calls, new contact
acceptance, auth changes, migration, budget or retry paths.

## Why not SAX/stream extraction yet?
A streaming HTML tokenizer (e.g. parse5 SAX) can eventually discard inert
DOM content while examining much larger pages. However, safely promoting
person/email evidence from a document prefix requires whole-document
ambiguity and conflict detection; without completing the parse it could miss
a second person or contradictory address later. This bounded full-document
change is the smallest independently testable improvement.

References:
- WHATWG HTML parsing: https://html.spec.whatwg.org/multipage/parsing.html
- Node streams: https://nodejs.org/api/stream.html
- parse5 SAX: https://parse5.js.org/classes/parse5-sax-parser.SAXParser.html

## Verification and release
New tests cover 256/320 KiB inert HTML with direct and JSON-LD evidence,
oversized visible evidence, raw document >512 KiB, redirects and compressed
response refusal. Existing 96 KiB and 128 KiB regressions remain required.
No historical content is stored for replay, so these offline tests do not
prove how many of the four prior size failures will be recovered.
Run exact-HEAD CI, CTO review, and approve a separate bounded smoke test
only after deployment. No paid run or production mutation is authorized by
this PR.
