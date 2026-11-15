# AI40 — Broad public-web expert discovery and contact evidence

## Goal

Gary can search for professionals on the **public internet as a whole**,
not only a supplied list of websites. A website supplied by Gary is a
starting point or optional search criterion, never an implicit allow-list.

Use the existing `POST /api/discovery/ai-research`, Google workspace
membership, personal encrypted BYOK credentials, source normalization,
owner-wide spend reservations and explicit activation gate. Do not build
another privileged search endpoint or enable email sending.

## Increment 1 (this PR)

- Shared bounded discovery guidance for Anthropic, OpenAI and Gemini
  encourages official sites, professional profiles, speaker bios,
  articles and multiple independently cited domains.
- `observedPublicBusinessContacts` is a **pure server-side contract** for
  future vetted document retrieval. It only accepts actually inspected page
  text and an exact HTTPS URL also present in provider-authoritative citations.
- Only generic business-role inboxes on a domain compatible with the
  inspected page can be proposed. Personal mailboxes, ungrounded email
  strings, unrelated domains and unsafely formed URLs are rejected.
- Every proposal is `REVIEW_REQUIRED`, with
  `identityVerified:false` and `contactPermission:false`.
- This PR does **not** scrape, fetch websites, return new email fields
  from the paid research endpoint, auto-import candidates, send outreach
  or enable billable provider requests.

## Increment 2 (this PR)

- `retrieveCitedPublicPage` is an **opt-in** HTTPS source inspector with
  DNS resolution and connection-time IPv4 pinning; private/mixed IPv4
  answers are rejected. Dual-stack addresses may use a validated public
  IPv4; IPv6-only hosts fail closed pending a complete egress policy.
- Robots exclusion is checked before each document fetch; a missing
  robots policy (HTTP 404) permits inspection, while robots fetch failure,
  unsupported wildcard patterns, redirects and disallow rules reject it.
- Content is strictly limited to text/html or text/plain, UTF-8, 64 KiB
  per request, 4 seconds per request, and **no redirects**.
  HTML scripts/styles are discarded; no JavaScript is executed.
- A bounded post-provider, post-settlement enrichment stage may inspect
  at most two provider-cited candidate pages. Failed inspections result
  in sanitized, non-fatal warnings and never authorize a second AI call.
- The integration is disabled by default unless both
  `AI_WEB_RESEARCH_ENABLED=true` and the separate
  `AI_PUBLIC_CONTACT_INSPECTION_ENABLED=true` are configured.
  The latter must **remain OFF** until deployment-specific source policy,
  legal access review, live security smoke and logging controls pass.
- The UI renders observed general business inboxes in a separate
  review-only section, never as an individual's email.

## Next required increments

1. Validate live egress and DNS policy against public/blocked domains,
   robots variants, redirect attacks, slow streams and mixed DNS answers.
   Obtain publisher-specific access approval where required.
2. Associate organization-level contacts with an expert only after a
   separately reviewable identity and organization evidence step.
3. Rank evidence-linked results for usefulness and reduce duplicates
   across independent domains, without inventing confidence scores.
4. Add workspace-isolation and permission-revocation smoke to the
   disabled-by-default inspection stage; maintain provider pricing
   gates before any billable search activation.

The feature's server-side contact evidence does **not** assert
deliverability, lawful basis, consent or permission to send outreach.
Current deployment has `AI_WEB_RESEARCH_ENABLED=false`; keep it OFF.


## Increment 3 — attributed source evidence and identity collision review

- `associateBusinessContactsWithCandidates` conservatively binds a
  server-observed general business inbox to candidate names only through the
  exact same provider-cited page URL. It does **not** verify employer,
  affiliation, control of an address, outreach permission or deliverability.
- When multiple experts share one source page, the association is labeled
  `SHARED_SOURCE_AMBIGUOUS`. A single name receives only
  `SAME_CITED_PAGE_UNVERIFIED`, never a verified-person association.
- `findCandidateIdentityCollisions` flags normalized name collisions across
  distinct provider-cited URLs for human review and never automatically
  merges or discards profiles based on name spelling.
- The partner preview displays these explicit review signals, with no change
  to candidate import, persisted contacts, permissions or email sending.

Next focus: stronger independent identity/organization evidence and
cross-provider relevance ranking, along with a hard price-reviewed
search-tool budget and controlled real-provider staging testing.
