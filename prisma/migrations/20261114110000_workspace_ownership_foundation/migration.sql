-- Preparation only. Historical admin data remains unassigned and admin-only.
-- Never infer which invited partner owns legacy candidate or draft records.
ALTER TABLE "Candidate" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "OutreachDraft" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "CandidateEvidence" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "AiSetting" ADD COLUMN "workspaceId" TEXT;

ALTER TABLE "Candidate" ADD CONSTRAINT "Candidate_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OutreachDraft" ADD CONSTRAINT "OutreachDraft_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CandidateEvidence" ADD CONSTRAINT "CandidateEvidence_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AiSetting" ADD CONSTRAINT "AiSetting_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "Candidate_workspaceId_createdAt_idx" ON "Candidate"("workspaceId", "createdAt");
CREATE INDEX "OutreachDraft_workspaceId_createdAt_idx" ON "OutreachDraft"("workspaceId", "createdAt");
CREATE INDEX "CandidateEvidence_workspaceId_capturedAt_idx" ON "CandidateEvidence"("workspaceId", "capturedAt");
CREATE UNIQUE INDEX "AiSetting_workspaceId_key" ON "AiSetting"("workspaceId");
