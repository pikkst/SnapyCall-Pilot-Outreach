-- Existing observations remain unlinked until explicit source-backed email approval.
ALTER TABLE "ResearchCampaignObservation" ADD COLUMN "candidateId" TEXT;
CREATE INDEX "ResearchCampaignObservation_candidateId_idx"
  ON "ResearchCampaignObservation"("candidateId");
ALTER TABLE "ResearchCampaignObservation"
  ADD CONSTRAINT "ResearchCampaignObservation_candidateId_fkey"
  FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
