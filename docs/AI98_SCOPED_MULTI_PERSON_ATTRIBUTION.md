# AI98 — scoped attribution on shared public sources

## Problem
The latest measured AI98 run had 11 `SHARED_SOURCE_REQUIRES_REVIEW` outcomes among
22 email-inspection records. The existing verifier rejects any reused URL
before fetching it, even when that URL contains **independently labelled**
contacts for multiple named professionals.

## Explicitly limited v1
Reuse the bounded, independently authorized public HTTPS reader and the existing
`classifyExplicitPersonEmailPage` classifier. Accept only `schema.org/Person`
records on one fully fetched document, under a bounded JSON-LD script or @graph:
- 2–20 people, each with a unique exact name and explicit unique email.
- Reject absent names/emails, duplicate names, shared mailboxes, extra graph
  records beyond the cap, non-schema contexts and malformed JSON.
- Reject generic organizational mailboxes using the existing shared email
  normalization contract.
- Match the requested full name exactly (normalized case/whitespace), never
  by position, proximity, company domain or generated address.
- Explicit visible contradictory target name/email labels reject attribution.
- Bind SHA-256 to the canonical URL, target name/address and the **complete
  sorted multi-person evidence set**, so a changed third-party entry fails
  independent readback.
- Only allow the existing shared-URL collision guard to pass for such
  `sourceScoped` evidence. All other shared URLs still return
  `SHARED_SOURCE_REQUIRES_REVIEW`.
- Keep membership check, ownership, immutable fingerprint, exact-cycle approval,
  guarded DB transaction and compare-and-swap behavior unchanged.

A successful result is **REVIEW_REQUIRED**, never a verified mailbox,
approved Candidate, send eligibility or outreach permission. No new provider
calls, crawlers, endpoints, database migration, payment authorization or
automatic source expansion.

## Intentional limitation
This does not parse arbitrary nested team cards, tables or directory markup.
Shared pages without explicit complete JSON-LD Person records remain blocked.
A future DOM-based extractor would need robust structural isolation and
adversarial ambiguous-markup tests, not text-proximity inference.

## Validation
- Positive multi-person exact-name extraction and independent DB readback.
- Duplicated names, email reuse, organization inboxes, missing fields and
  conflicting visible person/email evidence rejected.
- Shared generic page still denied; no document-derived source acceptance.
- Tampering with another person's block invalidates stored evidence digest.
- Membership revocation after fetch prevents persistence.

## Rollout
PR review, exact-HEAD CI, and no active paid leases before deployment.
Do not claim increased yield without a separately approved bounded run.
