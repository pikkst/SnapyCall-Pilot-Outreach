# RD-01C Historical Funnel Audit Preparation

Status: preparation only; no historical campaign was queried in this change.

The read-only CLI (`npm run research:funnel-baseline -- <campaign-id>`) requires `APP_ENVIRONMENT` to be `local-read-only` or `staging-read-only`, plus explicit `RESEARCH_WORKSPACE_ID` and `RESEARCH_OWNER_ID`. The preflight checks the effective PostgreSQL database, role, transaction read-only state, active membership, and owner/workspace campaign scope before the existing snapshot loader runs.

The environment label is not authorization. A restricted database role and an explicitly approved disposable or read-only database are required. The CLI does not create campaigns, execute research, call providers, mutate data, aggregate tenants, or print names, emails, private URLs, or raw evidence.

## Interpretation contract

Each funnel value is emitted with its unit, denominator, provenance, and reconstructability. Missing or truncated observations, audit events, reservations, or qualification history remain `null`/unknown; they are never converted to zero. Stage counts use distinct persisted units and must not be combined into incompatible conversion rates.

The output is suitable for aggregate review only. It distinguishes persisted reason-code counts, accessibility metadata, qualification, and unreconciled cost. Human contact acceptance remains unknown unless a separately persisted accepted state exists.

## Reproducible synthetic example

With an isolated test database and synthetic rows only:

```text
APP_ENVIRONMENT=local-read-only RESEARCH_WORKSPACE_ID=<workspace> RESEARCH_OWNER_ID=<owner> npm run research:funnel-baseline -- <completed-campaign>
```

The result is deterministic for the selected repeatable-read snapshot. An unsafe role, revoked membership, invalid scope, missing campaign, or non-read-only transaction returns an unavailable reason code and no funnel report.

## Remaining approval and evidence requirements

* CTO authorization for each real historical campaign, workspace, owner, and database.
* A restricted read-only PostgreSQL role with verified connection identity and schema compatibility.
* Confirmation that the selected campaign is completed and that the output may be reviewed.
* Exact-HEAD CI, including PostgreSQL permission/read-only integration tests, before review; no staging or production data was used here.
* Historical rates must remain unknown where records were not retained; synthetic fixtures cannot establish production false-negative rates.
