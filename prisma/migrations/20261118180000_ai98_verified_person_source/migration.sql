-- Explicitly authorized, independently fetched named-person evidence.
-- Never replace immutable provider citation or infer outreach consent.
ALTER TABLE "ResearchCampaignObservation"
  ADD COLUMN "personSourceUrl" VARCHAR(2048),
  ADD COLUMN "personSourceProvenance" TEXT,
  ADD COLUMN "personSourceVerifiedAt" TIMESTAMP(3);
ALTER TABLE "ResearchPersonSourceApproval"
  ADD COLUMN "publicInspectionAuthorized" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "ResearchCampaignObservation_personSourceUrl_idx"
  ON "ResearchCampaignObservation"("personSourceUrl");
