# AI98 source inspection outcome diagnostics

## Motivation
The 2026-11-19 full-run ended with 12/20 source calls and zero reviewable
person-email evidence. Earlier implementation collapsed all source searches
without an accepted proposal into `NO_UNIQUE_DIRECT_SOURCE`, discarding the
independent public-page inspection failure class. This prevented evidence-led
prioritization of the next yield improvements.

## Runtime contract
`inspectEvidenceBackedPersonSources` reuses the existing three-URL cap,
trusted citation validation, HTTPS/robots/DNS/redirect retrieval and strict
named-email classifier. It returns one selected hint (or null) plus bounded
counts: cited, attempted, unavailable, noNamedEmail and verified, and a
conflicting boolean. There are no extra provider calls or retries.

The existing `finishPersonSourceJob` persists only a stable outcome code in
`lastErrorCode` when no proposal survives and adds the bounded counters to its
existing audit event metadata. It does **not** write page text, person names,
source URLs, email addresses or provider payloads into diagnostics. A
collision discovered under the campaign lock has its own
`SOURCE_SELECTED_COLLISION` code. Existing pre-dispatch errors, conservative
billing settlement, membership checks, lease fencing and independent
`verifyPersonSourceProposal` remain unchanged.

Outcome codes:
- `SOURCE_NO_MATCHING_CITED_PROFILE`: no matching provider-cited URL
- `SOURCE_ALL_PAGES_UNAVAILABLE`: every bounded public read failed
- `SOURCE_NO_NAMED_EMAIL_EVIDENCE`: pages readable, strict label missing
- `SOURCE_MIXED_UNQUALIFIED`: mixture of unavailable and unqualified pages
- `SOURCE_CONFLICTING_PERSON_EMAILS`: independently confirmed contradiction
- `SOURCE_NAMED_EMAIL_SOURCE_SELECTED`: selected for downstream re-verification
- `SOURCE_SELECTED_COLLISION`: database rejects source shared by another job/observation

No contact is accepted, no mailbox ownership or outreach permission is inferred,
and no historical campaign is retroactively classified.

## Before enabling multi-page joins
Measure the distribution of these codes for a controlled budgeted run.
A cross-page identity-email join is **not** introduced here: official-site
contact pages can contain shared company inboxes, several people, or namesakes.
A separate PR must first define an explicit cross-page same-person proof
contract, admissible links, collision behavior and hard HTTPS/request budgets
without relaxing the current classifier.

## Validation
`node --test test/ai98-source-inspection-outcomes.test.js`
`npm run check && npm test && npm run typecheck`
Review exact-HEAD CI, existing financial/lease tests and staging smoke before
merge or deploy. No billable run is implied by this change.
