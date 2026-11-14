# Manual expert reference intake — source rights and review-only workflow

## Purpose
A signed-in Google partner may manually enter a professional's name,
category and a public HTTPS reference URL under their selected workspace.
The entry is a **lead seed for manual investigation**, not a verified expert,
a confirmed email address, consent or outreach eligibility.

The existing `POST /api/candidates?workspaceId=<verified-id>` accepts
`{ "manualSeed": true, "name": "...", "category": "...", "sourceUrl": "https://..." }`.
The server checks workspace membership inside the write transaction, generates
a deterministic discovery key from canonical name + URL, and returns the same
candidate on replay. Another workspace receives a separate candidate.
Rows retain `status: REVIEW_PENDING`, `profileReviewed: false`,
`contactReviewed: false`, `onlineEnglish: false`, `email: null`,
and `legalBasis: null`. A source link is only provenance. It does not
authenticate the source, grant a licence or permit promotional contact.

## Source use rules
- Manual discovery is not a waiver of a publisher's terms. Do not bulk
  copy third-party directory listings, access behind login/paywalls, or use
  automated scraping without an applicable authorization.
- The partner may record a minimal **reference** discovered by lawful human
  research. If commercial reuse of even that information is restricted,
  obtain the relevant licence/permission or use an independently permitted source.
- No automatic visit, fetch, crawl, enrichment or email extraction is
  performed when a seed is added. No provider key, web-search credits or
  sending channels are used.
- A separate independently supported profile may later be reviewed via the
  existing `/api/candidates/:id/expert-review` flow.
- A public business address does not prove legal basis or consent. Qualification,
  contact review, and email authorization remain separate human gates.

## Release and acceptance
CI: strict input normalization, unsafe URL rejection, deterministic replay,
no privilege/permission assertions; disposable PostgreSQL HTTP smoke:
CSRF, admin/partner separation, workspace isolation, idempotency and audit.
UI smoke is still required after an explicitly approved merge/deploy.
This feature does **not** activate `AI_WEB_RESEARCH_ENABLED`,
AI billing, automatic source collection, or outbound sending.
