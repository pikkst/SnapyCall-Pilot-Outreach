# Workspace ownership foundation — first gated PR

## Corrected product contract

Google login is the identity method, not a limited secondary application. Each invited
user must eventually get the same lead discovery, candidate review, AI drafting and
campaign workspace as the current admin, with data isolated by active workspace.

The existing Google OAuth consent remains a **separate** permission for the user's
own Google account. A user may attach an existing Google **Form** as a questionnaire
link in a reviewed outreach draft. Google Sheets/CSV/XLSX will support lead and
outreach import/export, with explicit field mappings and provenance. Neither path
may send unsolicited email or change Google document sharing permissions.

## What this PR does and does not do

- Add nullable foreign-key workspace ownership to Candidate, CandidateEvidence,
  OutreachDraft, plus lookup indexes. AI API keys remain per-identity via `AiSetting.ownerId`.
- Preserve all existing admin-only rows as `workspaceId = NULL`. No auto assignment,
  backfill, tenant data access, email sending, or change to deployed auth routes.
- Add a pure, reusable, fail-closed workspace membership check. Membership requires
  a verified Google subject, matches the requested workspace and is not revoked.
- Add a reusable exact workspace filter contract and regression tests.

**Not yet ready to enable**: Partner routes still show the limited Google connection
screen; the old admin CRUD routes are intentionally admin-only. This prevents exposing
global Candidate, AI keys and drafts to Google-authenticated users prematurely.

## Next PR gate (mandatory before partner CRUD access)

1. Scope every existing candidate read, write, profile review, evidence, duplicate
   suggestion, RSS import, AI draft and audit operation by workspace.
2. Scope AI settings by authenticated user (`AiSetting.ownerId = PartnerUser.id`),
   not workspace; never return an admin key to a partner, including via error paths.
3. Scope CandidateEvidence and OutreachDraft to the same workspace as their Candidate
   in a transaction; prevent cross-workspace FK references.
4. Change global Candidate.emailNormalized and discoveryKey uniqueness to workspace-
   scoped uniqueness, including careful nullable legacy behavior and upgrade path.
5. Provide a deliberate, audited admin ownership migration only after selecting
   the correct destination workspace. Do not infer from names or email addresses.
6. Share the same React workflow for admin and Google users with a workspace
   selector; keep admin-only partner management separate.
7. Verify negative authorization tests: uninvited, revoked, cross-tenant IDs,
   unknown candidate, stale session, forged workspace ID, duplicate replay.
8. Test clean-start and existing-Neon-upgrade Prisma migrations against disposable
   PostgreSQL, plus full exact-HEAD CI. Deploy only after CTO review.

## Rollout

Migration is additive but affects production/staging schemas. Do not merge or run
migrations without explicit review and deploy authorization. Real Google Form links
must be explicitly shared by their owners; Forms question/response read permission
alone does not make a private Form publicly answerable.
