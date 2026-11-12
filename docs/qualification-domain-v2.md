# Qualification Domain v2 — 2026-11-12

## Purpose
Qualification is an evidence-gated decision, never a campaign allocation score.
The initial product goal is 20 accepted pilot experts; the existing category
30/30/20/20 and region 40/40/20 ratios are **recruitment targets**, not
quality or merit points.

## Existing contracts and compatibility
- Keep `Candidate`, its fields and historical status values unchanged.
- Compute `qualificationDecision(candidate)` and `outreachDecision(candidate)`
  from the persisted evidence. No new column, migration or backfill.
- `scoreCandidate` stays available to old callers, but its `score` is
  `null` until a validated evidence-scoring model is introduced. The
  `eligible` boolean now means qualification evidence is present.
- The server is the authority. Candidate API returns `qualification` and
  `outreach`; browser controls use `outreach.canDraft`, not a local
  guess at the eligibility rules.
- `sourceUrl` remains the source profile for legacy manual records and
  the original article for RSS-derived records. RSS candidates additionally
  require explicit independent `expertProfileUrl` review.
- Historical records remain queryable; current evidence checks may now prevent
  generating a new draft that older versions allowed. Old drafts are retained.
- No automated send endpoint is added.

## Computed workflow
1. `DISCOVERED`: RSS byline, no confirmed English sessions/profile.
2. `EVIDENCE_PENDING`: evidence incomplete; no qualification or AI draft.
3. `QUALIFIED`: required expert/English evidence exists, no email contact.
4. `CONTACT_REVIEW`: contact exists, but legal basis or contact review missing.
5. `DRAFT_READY`: required expert and contact checks completed.
6. `SUPPRESSED` and `REJECTED`: override any positive flags.

These are derived, not user-settable statuses. The existing DB `status`
remains a legacy review attribute. Do not couple transitions to client-supplied
stage values. `canSend` is always false.

## Release gates
- Unit tests: category/region allocations don't alter quality; no imaginary
  numeric merit; review states, suppression and rejection, RSS provenance.
- HTTP smoke with disposable Postgres: server/client stage and draft gate
  reflect the same domain logic for discovered and manually created records.
- Existing Neon staging migration count must remain unchanged.
- After merge and explicit deploy approval, confirm the existing
  `TimidRobot` record is visible, not duplicated or promoted, and old
  drafts (if any) remain readable.
- Dedicated UX and evidence/source-data models are follow-up work.
