-- Owner/workspace access is inherited from the parent ResearchCampaign.
-- URLs are untrusted queue inputs: no automatic provider call, contact, or email.
CREATE TABLE "ResearchCampaignSource" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "normalizedUrl" VARCHAR(2048) NOT NULL,
    "normalizedUrlHash" CHAR(64) NOT NULL,
    "sourceKind" TEXT NOT NULL DEFAULT 'USER_URL',
    "status" TEXT NOT NULL DEFAULT 'PENDING_ENRICHMENT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ResearchCampaignSource_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ResearchCampaignSource_campaignId_normalizedUrlHash_key"
    ON "ResearchCampaignSource"("campaignId", "normalizedUrlHash");
CREATE INDEX "ResearchCampaignSource_campaignId_status_createdAt_idx"
    ON "ResearchCampaignSource"("campaignId", "status", "createdAt");
ALTER TABLE "ResearchCampaignSource"
  ADD CONSTRAINT "ResearchCampaignSource_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "ResearchCampaign"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
