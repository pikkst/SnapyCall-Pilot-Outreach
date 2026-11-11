# Free lead discovery: reviewed RSS/Atom authors (MVP)

## Scope and costs

This milestone uses only administrator-approved public RSS/Atom feeds and the
existing Node.js + Neon deployment. It does **not** call paid discovery, search,
email enrichment or LinkedIn APIs. Network transfer and Render/Neon hosting may
still incur infrastructure costs under their respective plans; the application
does not guarantee unlimited free external requests.

AI model usage remains optional and separate. Scanning feeds itself never
calls Gemini or OpenAI.

## Configuration

Review each publisher's terms and its syndication/automation permissions before
adding the exact public HTTPS RSS/Atom URL to `DISCOVERY_FEED_URLS`, e.g.:

```text
DISCOVERY_FEED_URLS=https://example.org/feed.xml,https://example.net/rss
```

The examples are placeholders, not verified sources. There are **no default
sources**. This prevents silently scanning websites that did not authorize
automated collection. Feed URLs are an administrative deployment setting,
not arbitrary user-supplied network destinations.

The scanner:
- Uses a recognizable user agent and checks the publisher's robots.txt.
- Fails closed on unreachable/disallowing robots.txt and HTTP errors.
- Does not follow redirects or use login cookies.
- Limits responses, run count and fetch timeout.
- Does not fetch linked articles or follow author profile links.
- Uses syndication-supplied author names and article URLs only. A byline is
  not proof of expertise or identity.
- Rejects unsupported/malformed source documents rather than manufacturing
  candidates from article titles.
- Keeps imported candidates unverified, without invented email or
  online-English eligibility, and marks them `REVIEW_PENDING`.

The UI displays candidates and original article links. The administrator
chooses a category and explicitly imports each reviewed item. A deterministic
unique `discoveryKey` makes retries safe. Existing candidates are not
overwritten by subsequent imports.

## Limitations

This is a **source-driven discovery proof of concept**, not a comprehensive
people search engine. RSS/Atom feeds identify authors who may be prospective
experts, not necessarily available online consultants. Few publish email
addresses; none are inferred. Quality and author identity must be verified
before outreach. No automated sending and no LinkedIn account automation.

Do not use Google/Bing HTML scraping or circumvent robots rules to replace
paid APIs. For broader coverage, onboard additional reviewed public
sources or integrate permitted data exports with provenance.

## Acceptance test

1. Configure one legitimately approved source in Render staging.
2. Open *Free discovery*, select the source and scan.
3. Confirm author names and matching articles are grounded and correct.
4. Import a review candidate; repeat the same import and verify only one
   record remains.
5. Verify the candidate has `REVIEW_PENDING`, `onlineEnglish=false`,
   no invented email, and cannot trigger outreach.
6. Confirm zero discovery-provider/API charges and no email traffic.

Do not merge or deploy to staging without a separate authorization.
