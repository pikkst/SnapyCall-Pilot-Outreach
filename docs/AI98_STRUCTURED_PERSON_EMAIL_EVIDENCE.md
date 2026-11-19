# AI98 — Strict schema.org Person evidence (P1)

## Measured issue
The 2026-11-19 run `cmwnwn48q0001fd3kpylcifri` completed 10 source jobs,
28 source URL inspections, 17 unavailable pages, 11 readable pages without
qualifying person-email proof, and zero verified contacts. Source observations
also included five shared citations requiring review. The 8 content failures
remain distinct from the 11 readable pages and require a separate header-level
analysis; this PR does not claim to resolve those inaccessible documents.

## Smallest production-grade expansion
The existing trusted HTTPS reader already promotes visible labeled
`mailto:` anchors and one unambiguous H1. It previously stripped *all*
script contents, including public schema.org Person JSON-LD. Instead of a
parallel crawler, this change extracts at most one explicit Person object
from bounded `application/ld+json` scripts embedded in the **same already
authorized HTML document**.

- Require schema.org `@context`, `@type=Person`, a single full name and
  one complete explicitly published email string. Limited `@graph` is supported.
- Reject multiple Person objects, non-Person contact properties, untrusted
  contexts, arrays of names/addresses and malformed/oversized JSON.
- Classifier matches the exact requested name, applies existing
  `normalizedEmail` generic inbox restrictions, checks for conflicting
  visible addresses and explicit alternative name labels, and binds the proof
  digest to the source URL, exact name and address.
- Independent verifier and readback already re-fetch this page through the
  same trusted reader and reclassify evidence. A changed source cannot
  silently preserve a prior proof.
- Evidence is **review-required** only. No mailbox ownership confirmation,
  consent, auto-acceptance, Candidate import, delivery enablement or sending.

## Explicit boundaries
No new provider calls or additional source URLs; same approval, spend ceiling,
lease and no-retry rules. No change to robots rules, DNS/SSRF, MIME, payload
limits, redirect validation, or raw HTML persistence. Organization/aggregate
metadata cannot qualify. JSON-LD is untrusted source content; the parser never
fetches remote `@context` or arbitrary external URLs.

This is not evidence that prior zero-yield campaigns would have found contacts:
actual prior HTML was not stored for deterministic replay. No production
data is modified by these tests. The next controlled run must report source
availability and reviewable person-email evidence separately.

## Validation
`node --test test/ai98-structured-person-evidence.test.js`, full
`npm test`, `npm run check`, `npm run typecheck`, exact-HEAD CI,
and staging read-only smoke. No merge/deploy/paid calls without approval.
