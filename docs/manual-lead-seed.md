# Manual Lead Seed — human-provided expert intake

This is an explicitly manual workflow for partner workspace users. Gary or
another verified partner enters the professional's name, sector and a page URL
that they actually reviewed. The app **does not fetch or crawl the source page**,
parse its contents, enrich the person's contact info or contact the person.

## API and authorization

Reuse `POST /api/candidates?workspaceId=...` with a strict `manualSeed:true`
DTO `{manualSeed,name,category,sourceUrl}`. The established auth, Origin and
workspace membership fence apply. Admin legacy identity cannot use this new
partner-only mode. It writes into the existing `Candidate` table with
`status=REVIEW_PENDING`, no email, no contact-reviewed state, no legal basis,
and no verified English availability.

Equivalent name + canonical public HTTPS reference in a workspace is idempotent:
returns 201/created on the first write and 200/created:false on replay. A
transactional workspace row lock fences concurrent retries, while the standard
`candidate.created` contract remains backwards-compatible. Different
workspaces may reference the same public expert independently.

## Source use and legal controls

A human-entered URL is provenance, **not** a license to crawl, copy, or use
publisher content commercially. Restricted directories (including sources Gary
suggests) remain outside the automatic discovery allowlist without separately
verified terms/permission. Do not turn a manual lead into an automated scraper
or treat the displayed name as independently verified.

Contact enrichment and AI web search remain separate, gated workflows; only
independently permitted sources may be consulted. This manual intake never
authorizes unsolicited commercial mail. Reviewed evidence, contact channel,
lawful basis and applicable jurisdictional outreach requirements require
separate attestation. Gmail sending remains disabled.

## Verification

Unit tests cover malformed and unsafe URLs, unauthorized extra fields and
identity claims. Disposable Postgres HTTP smoke covers scoped owner writes,
admin/CSRF rejection, cross-workspace isolation, concurrent retry idempotence,
audit once and absence of email, legal basis and qualification claims.
