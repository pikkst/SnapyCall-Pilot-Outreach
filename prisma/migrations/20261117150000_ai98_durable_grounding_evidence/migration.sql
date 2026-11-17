-- A provider grounding citation remains immutable in citationUrl.
-- Resolution records are separate unverified hints, never email or Candidate evidence.
ALTER TABLE "ResearchCampaignObservation"
  ADD COLUMN "groundingStatus" TEXT NOT NULL DEFAULT 'UNCHECKED',
  ADD COLUMN "groundingResolvedUrl" VARCHAR(2048),
  ADD COLUMN "groundingProvenance" TEXT,
  ADD COLUMN "groundingCode" TEXT,
  ADD COLUMN "groundingResolvedAt" TIMESTAMP(3);

ALTER TABLE "ResearchCampaignObservation"
  ADD CONSTRAINT "ResearchCampaignObservation_groundingStatus_check"
    CHECK ("groundingStatus" IN ('UNCHECKED', 'SOURCE_HINT', 'UNRESOLVED', 'REJECTED')),
  ADD CONSTRAINT "ResearchCampaignObservation_groundingEvidence_check"
    CHECK (
      ("groundingStatus" = 'UNCHECKED' AND "groundingResolvedUrl" IS NULL
         AND "groundingProvenance" IS NULL AND "groundingCode" IS NULL
         AND "groundingResolvedAt" IS NULL)
      OR ("groundingStatus" = 'SOURCE_HINT' AND "groundingResolvedUrl" IS NOT NULL
         AND "groundingProvenance" = 'GOOGLE_GROUNDING_LOCATION_HEADER'
         AND "groundingCode" IS NULL AND "groundingResolvedAt" IS NOT NULL)
      OR ("groundingStatus" IN ('UNRESOLVED', 'REJECTED')
         AND "groundingResolvedUrl" IS NULL AND "groundingProvenance" IS NULL
         AND "groundingCode" IS NOT NULL AND "groundingResolvedAt" IS NOT NULL)
    );

CREATE INDEX "ResearchCampaignObservation_campaignId_groundingStatus_id_idx"
  ON "ResearchCampaignObservation" ("campaignId", "groundingStatus", "id");
