-- Replace global candidate identity uniqueness with workspace-scoped keys.
-- Postgres NULL semantics require explicit partial indexes for legacy-admin
-- records; otherwise historic admin data could silently accept duplicates.
-- Create all replacement constraints BEFORE removing the existing indexes.
CREATE UNIQUE INDEX "Candidate_workspaceId_emailNormalized_key"
  ON "Candidate"("workspaceId", "emailNormalized");
CREATE UNIQUE INDEX "Candidate_workspaceId_discoveryKey_key"
  ON "Candidate"("workspaceId", "discoveryKey");
CREATE UNIQUE INDEX "Candidate_legacy_emailNormalized_key"
  ON "Candidate"("emailNormalized")
  WHERE "workspaceId" IS NULL AND "emailNormalized" IS NOT NULL;
CREATE UNIQUE INDEX "Candidate_legacy_discoveryKey_key"
  ON "Candidate"("discoveryKey")
  WHERE "workspaceId" IS NULL AND "discoveryKey" IS NOT NULL;

DROP INDEX "Candidate_emailNormalized_key";
DROP INDEX "Candidate_discoveryKey_key";
