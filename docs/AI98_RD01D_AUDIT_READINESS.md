# RD-01D Historical Funnel Audit Readiness

Status: ready for controlled CTO review; **NO-GO for a real historical audit until campaign/workspace/owner scope and database authorization are supplied**.

## Verified baseline

This assessment is based on `origin/main` merge commit `885b221` (PR #197), in the local validation environment on 2026-11-20. It reuses the RD-01A reducer (`server/research-funnel-baseline.js`), RD-01B trusted snapshot loader (`server/research-funnel-snapshot-loader.js`), RD-01C preflight (`server/research-funnel-audit-preflight.js`), and `research:funnel-baseline` CLI. No new endpoint, pipeline, provider adapter, reducer, migration, or authorization path is introduced.

The merged exact-HEAD CI evidence for PR #197 included successful `CI`, `Pilot app CI`, isolated PostgreSQL integration, and staging read-only smoke. No staging or production data was queried for this readiness work.

## Database and schema contract

The audit connection must use a separately approved PostgreSQL login whose actual database and role match `RD01_AUDIT_DATABASE` and `RD01_AUDIT_ROLE`. The role must be `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION`, and `NOBYPASSRLS`; it must have `CONNECT`, schema `USAGE`, and `SELECT` only for the required public tables. It must have no `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, schema `CREATE`, or database `CREATE` privilege.

The loader verifies the effective database, role, transaction read-only state, role flags, table write privileges, schema/database create privileges, and required columns in one `RepeatableRead`/`READ ONLY` transaction. It also rechecks active membership, exact campaign/workspace/owner ownership, terminal campaign status (`COMPLETED` or `PARTIAL`), and snapshot completeness.

Required schema tables are the persisted inputs used by the loader: membership, campaign, observations, source jobs, reservations, audit events, campaign tasks/runs, full runs, and contact batches/items. A schema mismatch fails closed.

## Required authorized selection

The CTO/operator must provide these values through an approved secret-free execution context; they must not be guessed or discovered by scanning shared environments:

```text
APP_ENVIRONMENT=local-read-only|staging-read-only
RD01_AUDIT_DATABASE=<approved database name>
RD01_AUDIT_ROLE=<approved restricted role name>
RESEARCH_WORKSPACE_ID=<approved workspace id>
RESEARCH_OWNER_ID=<approved owner id>
CAMPAIGN_ID=<approved terminal campaign id>
```

Selection should include completed or partial campaigns with known research execution history and, where available, Source-stage activity. The approved cohort should include differing outcomes, including zero-qualified-contact campaigns; successful campaigns must not be cherry-picked as the only sample.

## Read-only execution procedure

1. Confirm CTO authorization for the exact database, role, workspace, owner, and campaign cohort.
2. Confirm the database is disposable or explicitly approved read-only audit infrastructure; never use a production credential in local work.
3. Supply `DATABASE_URL` from the approved secret manager or process environment using the restricted `audit_reader` credential; never commit or print it. Use `DATABASE_URL=<secret-manager-injected-value>` rather than placing a literal credential in command history.
4. Run one explicit campaign at a time:

```text
APP_ENVIRONMENT=local-read-only RD01_AUDIT_DATABASE=<database> RD01_AUDIT_ROLE=<role> RESEARCH_WORKSPACE_ID=<workspace> RESEARCH_OWNER_ID=<owner> npm run research:funnel-baseline -- <campaign-id>
```

5. Retain only sanitized aggregate JSON and bounded reason-code counts. Do not retain names, emails, private URLs, raw evidence, credentials, or provider payloads.
6. Compare output completeness before interpreting any conversion or loss rate. `null`/unknown is not zero.

## Sanitized report template

The eventual report must preserve each metric's value, unit, provenance, denominator, and reconstructability. The actual CLI emits these fields per metric; this is a sanitized shape example:

```json
{
  "campaign": "<approved opaque id>",
  "status": "COMPLETED|PARTIAL",
  "funnel": {"discoveryCalls": {"value": null, "unit": "provider calls started", "denominator": null, "source": "ResearchCampaignRun.startedTasks", "reconstructable": false}},
  "qualification": {"qualifiedEvidence": {"value": null, "unit": "independently qualified person-email evidence", "denominator": null, "source": "summarizeQualifiedEmailEvidence", "reconstructable": false}},
  "cost": {"totalChargedCents": null, "unit": "cents", "denominator": null, "source": "ResearchSpendReservation.chargedCents", "reconstructable": false},
  "limitations": []
}
```

## Synthetic evidence matrix

The isolated PostgreSQL end-to-end test (`test/research-funnel-audit.e2e.integration.test.js`) runs in the disposable CI database through the existing loader and reducer output path. Its synthetic cohort covers discovery-only, source failures, inaccessible metadata, named-email review, qualified evidence, incomplete observations, missing audit metadata, missing reservations, and truncation. It asserts sanitized output and explicit unknown values. Existing reducer and loader tests additionally cover duplicate audit references, revoked membership, ownership scope, and restricted-role denial.

The end-to-end cohort uses an existing isolated terminal campaign for the real loader transaction and synthetic snapshot fixtures for the reducer cases. Expected results are zero only when the persisted denominator proves zero; otherwise the value remains unknown. Cross-workspace and oversized-snapshot rejection remain covered by the existing loader tests.

## Abort and rollback criteria

Abort before reading campaign rows if identity, role, privilege, schema, membership, ownership, status, or transaction read-only checks fail. Abort interpretation if observations, audits, or reservations are incomplete. Do not retry an ambiguous database operation, broaden scope, run provider calls, mutate persisted data, or continue after any credential/environment mismatch. There is no data rollback because the procedure is read-only; discard any local output that violates sanitization.

## Known limitations and remaining authorization

Historical records may not contain complete inspection metadata, qualification evidence, accepted-contact state, or reservation reconciliation. Synthetic fixtures cannot establish historical false-negative rates. Cross-campaign aggregation is not permitted unless every campaign shares an explicitly approved workspace/owner scope and the report preserves per-campaign denominators.

The first real audit remains **NO-GO** pending: CTO approval of the exact campaign cohort; approved workspace and owner identifiers; approved restricted database role and database identity; retention/access approval for sanitized output; and confirmation that no shared staging/production data or paid provider request is involved.

Recommendation: after those approvals, run a small heterogeneous cohort, review the sanitized report, and return measured loss distributions to the CTO before any RD-03/RD-04 implementation decision.

