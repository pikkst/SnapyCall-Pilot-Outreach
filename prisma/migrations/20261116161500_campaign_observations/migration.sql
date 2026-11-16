-- A campaign observation is an unverified provider-cited research candidate.
-- It never constitutes approval to contact, and is distinct from Candidate.
CREATE TABLE "ResearchCampaignObservation" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "evidenceKey" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "citationUrl" TEXT NOT NULL,
  "rationale" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'UNVERIFIED',
  "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ResearchCampaignObservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ResearchCampaignObservation_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "ResearchCampaign"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ResearchCampaignObservation_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "ResearchCampaignTask"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ResearchCampaignObservation_campaignId_evidenceKey_key"
  ON "ResearchCampaignObservation"("campaignId", "evidenceKey");
CREATE INDEX "ResearchCampaignObservation_campaignId_observedAt_id_idx"
  ON "ResearchCampaignObservation"("campaignId", "observedAt", "id");
CREATE INDEX "ResearchCampaignObservation_taskId_idx"
  ON "ResearchCampaignObservation"("taskId");
