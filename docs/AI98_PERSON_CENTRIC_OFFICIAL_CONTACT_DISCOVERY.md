# AI98 — Person-centric official contact discovery (P1)

## Evidence and root cause (2026-11-20)
The latest source run `cmwo9qzdq0001gf3pipwumb20` completed 5 Discovery
and 10 Source queries, inspecting 20 public URLs. Eleven were inaccessible
(8 robots, 2 HTTP, 1 DNS) and nine readable URLs contained no independently
attributable named email. No source job reached VERIFIED.

Current source searches previously used the **same** `"person" email contact
category official` query for all immutable queue reasons. The queue already
distinguishes `ALTERNATE_EMAIL_SOURCE`, `PERSON_SOURCE_REQUIRED` and
`SHARED_SOURCE`, but the search ignored that context. This particularly
wastes work on shared-profile candidates by repeatedly searching for
single-person biographies instead of official staff/contact pages.

## Smallest safe implementation
Use the existing `personSourceSearchQuery` and existing **frozen**
`queued.reason` in the owner-scoped claim transaction:

- ALTERNATE_EMAIL_SOURCE: retain original named email/contact query unchanged.
- PERSON_SOURCE_REQUIRED: named professional profile + contact/email.
- SHARED_SOURCE: named professional + team/staff contact/email on an official
  public source.

The full name remains an exact quoted term and professional category is
always preserved to disambiguate namesakes. All variants are deterministic,
bounded by the existing source-query input contract. The executor always
passes the persisted, approved `queued.reason` explicitly. For direct helper
calls, omitting `reason` intentionally defaults to `ALTERNATE_EMAIL_SOURCE`
for backward compatibility; an explicit unknown, empty or null reason is
rejected before dispatch. No missing reason can arise in the approved claim path.

## Important identity limitation
The current immutable observation snapshot has a person name, category and
cited URL but **no independently verified employer or organization field**.
Do not extract guessed employer/domain from provider prose, silently add
`site:` restrictions, or invent email patterns. A follow-up with a
first-party verified organization contract may safely use it, but requires
its own evidence/citation and immutable snapshot design.

## Unchanged production contracts
Exactly ONE approved Tavily/Gemini query per source job (or existing
provider-specific equivalent); no new provider call, retries, source jobs,
DB field, migration or endpoint. The same citation-bound model extraction,
HTTPS reader, robots, pinned DNS/SSRF, exact name/email classifier,
source-scoped readback, approval, owner budget reservation, leases and
uncertain-spend reconciliation remain untouched. Model-generated email
or URLs are not accepted. Contacts require explicit review and sending is
still disabled.

## What this does NOT prove
This deterministic query adjustment does not guarantee that any person
publicly publishes an email, or that the targeted sources will have fewer
robots denials. No new paid test was performed. Compare next bounded run
against similar approved query/model conditions, examining:
- qualified named-email evidence per 10 paid source jobs;
- each reason's selected jobs and observed public URL availability;
- independent verifier rejection reasons;
- cost ceiling and unresolved queue count.

A longer-term improvement should persist verified organization
affiliation separately with source attribution, not infer it from a
generic search snippet.
