# AI98 workspace daily quota policy

The former fixed 100 paid-research-attempt workspace cap is now an
administrator-owned `Partner.researchDailyLimit` (1..1000, default 1000).
The user's personal `ResearchUserLimits.dailyLimit` also accepts 1..1000.
The effective capacity is the smaller of the remaining workspace and
per-user-per-workspace quotas. Both discovery and person-source enrichment
consume the same attempt counters. UTC midnight resets counters by date
without deleting or rewriting past records.

## Administrative control

Admin Settings → Workspace daily research quotas lists each workspace
and its configured maximum. The existing admin-only
`GET /api/admin/partners` returns the cap. An authenticated administrator
can change it through `PUT /api/admin/partners/:id/research-limit`, guarded
by Origin validation, a 1..1000 parser, workspace row locking and an
append-only audit event. A partner session cannot invoke the admin route.
Lowering a cap below already-consumed attempts does not refund quotas.
Workspace mutations serialize with paid claims' existing Partner lock.

## User behavior

Personal Settings → My research limits allows a daily setting up to
1000. This is **not** a monetary allowance. An administrator-set
workspace cap may be lower; the Research Start panel's existing
`approved-run` read-only quota preflight shows both scopes and blocks
an approval that cannot fit within today's available slots. The
backend's approval preflight and atomic claim enforce the same caps.

The per-request candidate limit (20), maximum personal concurrency (3),
maximum workspace concurrency (5), minimum dispatch interval (35s),
monthly application budget, full-run worst-case price envelope, and
provider account billing are separate controls and remain unchanged.

## Release checklist

- Confirm exact-HEAD CI including unit, type/build and migration smoke.
- Apply the additive migration through the established Render release path.
- Check `Partner.researchDailyLimit` defaults to 1000 on existing and
  newly created workspaces; verify no `ResearchDailyQuota` data changed.
- Use read-only verification for a new, not-yet-approved campaign.
- Verify an admin can adjust workspace limit and an ordinary partner
  cannot (requires authenticated session manual smoke; do not use
  production-only mutations merely to probe it).
- Verify old `PAUSED` / `NEEDS_REVIEW` runs are unchanged.
- Do not automatically restart runs, trigger provider calls or email sending.

**Risk:** Increasing a quota can expand potential paid dispatch volume.
The actual spend remains bounded separately by application budget,
immutable per-run approval and provider-side account limits.
