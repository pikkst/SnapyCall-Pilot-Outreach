# AI98: one-hop same-host named-contact evidence

## Purpose
A provider-cited public professional biography may link to a separate contact
page. The previous source agent inspected only the cited page and could not
use that link. This change allows a deterministic, narrow evidence path
without general crawling, an additional paid provider call, or weakening
same-person attribution.

## Trust and attribution contract
1. The search result must first pass the unchanged trusted provider citation
   and exact target name/category envelope.
2. A bounded HTTPS read of that *cited root* must expose **exactly one** visible
   explicit `Contact` / `Contact me` / `Contact us` / `Get in touch`
   link to the same exact hostname. The target path must end in
   `/contact`, `/contact-me` or `/get-in-touch`, with no query,
   nonstandard port, credentials, IP-literal, or host transfer.
3. The linked page is independently fetched through the same pinned HTTPS,
   DNS/SSRF, robots, redirect and content-limits contract.
4. The *contact page itself* must explicitly label the exact full name
   and a single non-generic named personal email using the existing
   `classifyExplicitPersonEmailPage` contract. Do not combine a name-only
   biography with an anonymous company contact address. The two documents
   are not concatenated into manufactured proof.
5. The evidence digest binds the root URL, exact linked URL, and strict
   contact-page evidence digest. The persisted source URL remains the
   provider-cited biography. New provenance
   `AI98_EXPLICIT_NAMED_EMAIL_ON_LINKED_CONTACT` differentiates evidence.
6. The independent verifier repeats the root and linked page reads under
   existing membership, immutable observation fingerprint, source collision,
   exact-cycle approval and DB CAS fencing; its readback handler independently
   verifies the same two-document relationship.
7. A source job may perform at most three cited root inspections and **one**
   linked contact inspection; no arbitrary follow-on links, retries, paid
   prompts, contact acceptance, mailbox validation or email sending.
   The source executor only allows that extra fetch with more than 18s
   remaining on its 120s lease. The verifier's read is independently
   authorized and bounded.

## Failure behavior
Unavailable or blocked linked documents are not treated as evidence of
missing email. Invalid or ambiguous contact links are ignored. Any contact
page missing the exact name label or containing generic/multiple addresses
fails closed. Cross-host links and second-hop navigation remain forbidden.
A changed website may invalidate independent readback: no stale proof is
promoted by merely trusting a previous model answer.

## Release sequence
Stacked on PR #173 (diagnostic outcomes); after it merges, rebase or cleanly
retarget this PR to main and rerun exact-head CI. No migration or feature flag.
Require `npm run check`, `npm test`, `npm run typecheck`, DB smoke and
explicit review before merge. Do not schedule a new paid campaign as part of
this rollout. Inspect the source outcome distribution on the first controlled
run before increasing budgets.
