# Candidate identity — tenant-aware uniqueness (inactive foundation)

Existing global `Candidate.emailNormalized` and `Candidate.discoveryKey`
uniqueness conflicts with legitimate imports of the same prospect into distinct
partner workspaces.

This change replaces the global indexes with:
- Prisma composite unique `(workspaceId, emailNormalized)`
- Prisma composite unique `(workspaceId, discoveryKey)`
- PostgreSQL partial unique indexes for historical `workspaceId IS NULL` rows

PostgreSQL treats NULL values as distinct in composite unique indexes. Without
the two partial legacy indexes, admin-only duplicates would be silently allowed.
Both new and legacy constraints remain enforced by the database, including
concurrent inserts.

The existing admin-only discovery importer is changed from global `findUnique`
to `findFirst({ workspaceId: null, discoveryKey })`, retaining its idempotent
legacy behavior and its `P2002` reconciliation path.

## Not activated

No Google partner write routes are exposed by this PR. Candidate, Evidence and
Draft write operations still need server-side membership checks, atomic
same-workspace FK consistency and a shared React workflow. Do not add access
by reusing the legacy admin global mutation routes without those protections.

## Tests and rollout

The disposable PostgreSQL smoke verifies duplicate identifiers allowed across
distinct workspaces, rejected within one workspace and rejected among legacy
NULL-owned rows. Must also pass clean-start migration and existing-db upgrade
via Prisma CI. CTO review before merging; stage deploy and SQL evidence after
approval. No legacy backfill, live mail or production writes.
