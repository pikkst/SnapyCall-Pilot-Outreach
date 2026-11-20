# AI98 RD-02B Historical Campaign Audit Execution Plan

## Decision and scope

Status: `NO-GO FOR REAL-DATA EXECUTION`.

The CTO approved preparation, code analysis and isolated synthetic rehearsal,
but has not approved access to the historical campaign database. The November
20 campaign values (17 observations, 17/17 inspections, 10/10 source searches,
zero named-email evidence, zero qualified evidence, `PARTIAL`, and
`SOURCE_CONTINUATION_BUDGET_EXHAUSTED`) remain user-observed inputs until an
exact campaign snapshot is authorized.

Known from deployment metadata: database name `snapycall_pilot`. This does not
establish the environment, connection identity, restricted role, workspace,
owner or campaign scope and is not sufficient authorization.

## Missing authorization inputs

| Input | Current state | Required before execution |
|---|---|---|
| Environment | `UNAPPROVED` | CTO-approved existing database environment |
| Database identity | name only: `snapycall_pilot` | verified server/database identity |
| Role | unknown | separate restricted audit role |
| Workspace ID | unknown | exact authorized workspace |
| Owner ID | unknown | exact authorized owner |
| Campaign ID | unknown | exact November 20 campaign |
| Provider calls | prohibited | must remain zero |
| Data mutation | prohibited | must remain zero |

Identifiers must be supplied through an approved control-plane record or
owner-provided audit scope. They must not be discovered by querying campaign
tables.

## Existing execution path

The audit must reuse the existing RD-01 path:

1. `preflightHistoricalFunnelAudit()` validates environment selection,
   database/role identity, restricted role flags and required schema,
   membership and exact campaign ownership.
2. `loadResearchFunnelSnapshot()` opens `RepeatableRead` and `READ ONLY`,
   rechecks membership and campaign ownership, and loads bounded observations,
   source jobs, audits, reservations and stage rows.
3. `summarizeResearchFunnel()` produces sanitized aggregate metrics with
   denominators, source provenance, reconstructability and unknown values.

No CLI, endpoint, adapter, migration or competing reducer is required.

## Database security preflight checklist

The authorized execution must record pass/fail for:

- actual database name and server identity match the approved manifest;
- actual role is the approved restricted audit role;
- role is `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE` and `NOBYPASSRLS`;
- transaction reports `read_only = on`;
- role has no table `INSERT`, `UPDATE`, `DELETE` or `TRUNCATE` privilege;
- role has no schema or database `CREATE` privilege;
- required tables/columns are present and selectable;
- active workspace membership is present for the owner;
- campaign belongs to the exact workspace and owner;
- campaign is terminal (`COMPLETED` or `PARTIAL`);
- snapshot completes within the existing bounded limits.

Any failed item aborts the audit. No privileged fallback is permitted.

## Immutable execution manifest

The following is the reviewable manifest template. Unknown values are
intentionally not filled in.

```yaml
manifestVersion: AI98-RD02B-v1
repository: pikkst/SnapyCall-Pilot-Outreach
repositoryCommit: df71e58c8cc66925bf1ca922125ef856197738d3
auditImplementation: RD01C-preflight + RD01B-loader + RD01A-reducer
environment: UNAPPROVED
expectedDatabase: UNAPPROVED
expectedRole: UNAPPROVED
workspaceId: UNAPPROVED
ownerId: UNAPPROVED
campaignId: UNAPPROVED
approvedOutput:
  - sanitized aggregate metrics
  - allowlisted reason-code counts
  - denominators
  - reconstructability
  - confidence/status labels
operator: UNAPPROVED
executionDate: UNAPPROVED
expectedProviderCalls: 0
expectedDataMutations: 0
abortOn:
  - database identity mismatch
  - role privilege mismatch
  - read_only transaction mismatch
  - membership or ownership mismatch
  - non-terminal campaign
  - incomplete bounded snapshot where a complete metric is required
  - any request to emit personal or raw source data
```

## Measurement template

The final report must include value, denominator, source, reconstructability
and confidence for each measurement. Missing persisted evidence is `unknown`,
not zero.

| Area | Measures |
|---|---|
| Discovery | observations, distinct name/category identities, duplicate count, citation type |
| Email inspection | no email, ambiguous, blocked, shared-source review, verified evidence |
| Source jobs | planned, attempted, completed, failed, reason codes, repeated URLs/associations |
| Budget | reserved, reconciled charged, unreconciled/unknown, continuation inputs |
| Qualification | named-email review, qualified evidence, accepted contacts, unknown states |
| Termination | full-run status, stop code, approval/cycle counters, eligible queued jobs |

The report must distinguish reservation ceilings from reconciled provider
charges. It must not infer that a reserved amount was spent.

## Synthetic rehearsal evidence

The existing isolated tests already exercise the required contracts without
shared data:

- `test/research-funnel-audit-preflight.test.js` verifies restricted-role,
  read-only, membership and campaign failure modes;
- `test/research-funnel-snapshot-loader.test.js` verifies scoped loading,
  completeness/truncation, audit filtering and missing reservations;
- `test/research-funnel-baseline.test.js` verifies denominator-aware
  reduction, unknown values and sanitization;
- `test/research-funnel-snapshot-loader.postgres.integration.test.js` and
  `test/research-funnel-audit.e2e.integration.test.js` verify the real loader
  path when the isolated CI PostgreSQL environment is explicitly enabled.

The audit path performs no provider call and contains no write operation. A
future authorized run must use the existing restricted role and the same
loader/reducer path; it must not introduce a second CLI or diagnostic query
pipeline.

## Abort and rollback

This audit is read-only and has no rollback mutation. Abort immediately on any
preflight mismatch, scope ambiguity, privilege escalation, non-read-only
transaction, incomplete authorization, or attempt to access raw personal data.
Do not retry a failed shared-database execution with a broader role or an
application credential.

## GO / NO-GO

Current decision: **NO-GO for real-data execution**.

Preparation is complete. A future run becomes eligible only after CTO binds
the environment, verified database identity, restricted role, workspace ID,
owner ID and campaign ID. Until then, no historical conclusion about the
17-observation campaign is confirmed, and no provider spending, restart,
budget change or production mutation is permitted.
