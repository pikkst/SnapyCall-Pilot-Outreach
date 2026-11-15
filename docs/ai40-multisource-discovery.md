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

## Next required increments

1. Implement an authorized, tightly bounded public-page retrieval adapter:
   respect publisher terms and robots policy where applicable; block private
   DNS resolutions, DNS rebinding, redirects to non-public addresses,
   oversized responses and non-HTML; cap page count, time and bytes.
   Only its inspected text may be passed to the contact evidence contract.
2. Bind observed business-role contacts to a candidate only with explicit,
   reviewable source and organization evidence. Do not infer personal
   ownership, deliverability, opt-in or lawful outreach basis.
3. Rank reviewed results by evidence and topical relevance, not an invented
   confidence score; preserve namesake ambiguity and cite independent domains.
4. Add workspace-isolation tests, exact-provider fixtures, empty/invalid/
   unavailable source cases, import review tests, and a bounded financial
   envelope for provider tool costs before any paid staging smoke.

Current deployment has `AI_WEB_RESEARCH_ENABLED=false`. Keep it OFF.
