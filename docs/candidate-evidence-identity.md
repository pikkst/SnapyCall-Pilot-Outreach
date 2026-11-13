# Candidate Evidence & Identity — stacked milestone (2026-11-12)

Depends on [PR #11](https://github.com/pikkst/SnapyCall-Pilot-Outreach/pull/11) Qualification Domain v2. This PR targets the qualification feature branch to avoid silently shipping unfinished qualifications.

## Domain contract

- Candidate remains the identity/workflow aggregate and existing API data stays compatible.
- CandidateEvidence is an append-only, candidate-scoped provenance ledger.
- kind ARTICLE / PROFILE / SERVICE / OTHER, original URL, canonical URL, review note, timestamp and actor are recorded.
- Canonicalization removes fragments and common tracking query parameters, sorts remaining query parameters, and requires an HTTPS public DNS hostname.
- Unique(candidateId, kind, normalizedUrl) makes retries and concurrent identical submissions idempotent. The initial successful creation writes exactly one audit event.
- Adding evidence does NOT set profileReviewed, onlineEnglish, legalBasis, contactReviewed, or qualify a candidate. This is an observation, not independent verification or an AI conclusion.
- Old Candidate.sourceUrl and expertProfileUrl fields remain readable. No backfill, delete or merging of existing rows.
- GET and POST /api/candidates/:id/evidence are authenticated and write requests enforce Origin.
- GET /api/candidates/:id/possible-duplicates returns only *hints* from exact normalized email/profile matches, never name-only and never merges records. A bounded candidate scan returns incomplete=true when more than 500 other candidates exist; scaling this requires persisted canonical identity keys and indexed lookups.

## Caveats / follow-up

- User-entered source URLs are untrusted claims. There is no automated article verification, verified contact ownership, enrichment, or email sending.
- Multiple distinct URLs may refer to the same person; suggested identity matches require human confirmation. Do not auto-merge without a separate audited contract.
- The RSS import's historical single sourceURL remains unchanged. A future stage can automatically create an ARTICLE evidence entry inside the same transaction, but must remain backward-compatible and avoid duplicating notes.
- The single-admin MVP exposes candidate evidence only to the authenticated admin; future multi-user tenants require owner-scoped permissions and RLS/authorization redesign.

## Required release checks

- Pure normalization and duplicate hints, including unsafe URL rejection and homonymous names.
- Prisma clean-start migration and disposable PostgreSQL HTTP smoke: CSRF/401, append, replay, single audit record, original article unchanged, and qualification unmodified.
- Upgrade migration smoke from the four-migration staging baseline before release.
- No staging or production mutations until explicitly authorized.
