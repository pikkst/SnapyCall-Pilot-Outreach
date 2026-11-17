-- Historical observations remain UNCHECKED and are never auto-inspected.
-- No Candidate or email delivery changes. No provider spending authorization.
ALTER TABLE "ResearchCampaign"
  ADD COLUMN "emailTriageStatus" TEXT NOT NULL DEFAULT 'IDLE',
  ADD COLUMN "emailTriageAuthorizedAt" TIMESTAMP(3),
  ADD COLUMN "emailTriageExpiresAt" TIMESTAMP(3),
  ADD COLUMN "emailTriageMaxPages" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ResearchCampaignObservation"
  ADD COLUMN "emailTriageStatus" TEXT NOT NULL DEFAULT 'UNCHECKED',
  ADD COLUMN "emailTriageCode" TEXT,
  ADD COLUMN "emailTriageLeaseToken" TEXT,
  ADD COLUMN "emailTriageLeaseUntil" TIMESTAMP(3),
  ADD COLUMN "emailTriageEmail" TEXT,
  ADD COLUMN "emailTriageDigest" TEXT,
  ADD COLUMN "emailTriageAt" TIMESTAMP(3);
CREATE INDEX "ResearchCampaignObservation_campaignId_emailTriageStatus_id_idx"
  ON "ResearchCampaignObservation"("campaignId", "emailTriageStatus", "id");
ALTER TABLE "ResearchCampaign"
  ADD CONSTRAINT "ResearchCampaign_emailTriageStatus_check"
    CHECK ("emailTriageStatus" IN ('IDLE','RUNNING','PAUSED','COMPLETED')),
  ADD CONSTRAINT "ResearchCampaign_emailTriageMaxPages_check"
    CHECK ("emailTriageMaxPages" BETWEEN 0 AND 250);
ALTER TABLE "ResearchCampaignObservation"
  ADD CONSTRAINT "ResearchCampaignObservation_emailTriageStatus_check"
    CHECK ("emailTriageStatus" IN ('UNCHECKED','CHECKING','REVIEW_REQUIRED','NO_EMAIL','BLOCKED','UNCERTAIN')),
  ADD CONSTRAINT "ResearchCampaignObservation_emailTriageEvidence_check"
    CHECK (("emailTriageStatus" = 'REVIEW_REQUIRED' AND
      "emailTriageEmail" IS NOT NULL AND "emailTriageDigest" IS NOT NULL)
       OR ("emailTriageStatus" <> 'REVIEW_REQUIRED' AND
      "emailTriageEmail" IS NULL AND "emailTriageDigest" IS NULL));
