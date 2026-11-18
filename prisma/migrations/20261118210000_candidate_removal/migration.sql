-- Reversible workspace contact removal. Historical research and draft
-- evidence remain attached; no permanent personal-data erasure occurs.
ALTER TABLE "Candidate"
  ADD COLUMN "removedAt" TIMESTAMP(3),
  ADD COLUMN "removedBy" TEXT;
CREATE INDEX "Candidate_workspaceId_removedAt_createdAt_idx"
  ON "Candidate"("workspaceId","removedAt","createdAt");
