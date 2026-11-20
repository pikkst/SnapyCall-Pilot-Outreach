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
owner or campaign scope and is not sufficient authorization. The preflight
checks `current_database()` and `current_user`, but does not independently
authenticate the PostgreSQL server hostname or connection target. Before
execution, the approved connection target must be verified against trusted
deployment/configuration metadata. No connection string or secret belongs in
the report.

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

1. The executable path calls `loadResearchFunnelSnapshot()` and then
   `summarizeResearchFunnel()`; there is no separate CLI preflight invocation.
2. Inside its own `RepeatableRead` + `READ ONLY` transaction, the loader calls
   `checkAuditDatabase()` to validate the selected environment, current
   database/user, restricted role flags and required schema, then rechecks
   membership and exact campaign ownership before loading bounded observations,
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
connectionTarget: UNAPPROVED
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

### Reconstructability matrix

| Requested measurement | Status | Boundary |
|---|---|---|
| Persisted observations and distinct name/category identities | `SUPPORTED` | Bounded observation rows returned by the loader; duplicates are row-level, not person truth |
| Named-email review and qualified evidence | `SUPPORTED` | Reducer can count only complete, untruncated observations satisfying the persisted evidence contract |
| Source jobs planned, attempted, completed and persisted reason codes | `SUPPORTED` | Existing source-job rows and attempts; historical provider calls not present in persisted rows remain unknown |
| Individual/shared/redirect source classification | `PARTIAL` | Current snapshot exposes cited/proposed URLs and evidence fields, but not a complete historical taxonomy for every source hint |
| Repeated source URLs and person-source associations | `PARTIAL` | Exact persisted URLs/associations can be counted; prior provider results or unpersisted retries cannot be reconstructed |
| Reserved source-job cost and reconciled charged cost | `PARTIAL` | Returned reservations support known totals; missing/unreconciled reservations remain unknown |
| Discovery spending | `UNKNOWN` | Source-job reservations do not represent discovery spending, and the funnel snapshot does not provide a complete discovery cost ledger |
| Continuation-cycle decisions and stop inputs | `PARTIAL` | Persisted approval/cycle/job rows can show bounded counters and states, but only if the historical rows were retained and complete |
| Eligible jobs remaining at termination | `PARTIAL` | Current queued rows can be counted, but eligibility requires immutable manifest, drift, lease, approval and budget state at the stop transaction |
| Actual provider spend versus reserved ceiling | `UNKNOWN` unless reconciled | A reservation is not proof of provider charge; unknown billing must remain unknown |
| Terminal queued-task semantics | `SUPPORTED` for persisted state | Loader can report saved task states; it cannot prove whether an external worker would have been eligible without the full approval snapshot |

No new query is justified to promote a `PARTIAL` or `UNKNOWN` measurement to
`SUPPORTED`; the audit must report the limitation instead.

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
