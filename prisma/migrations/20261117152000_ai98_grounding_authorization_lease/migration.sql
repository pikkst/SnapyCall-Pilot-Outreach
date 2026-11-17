-- Explicit bounded, immutable owner approval. This migration never starts a worker.
ALTER TABLE "ResearchCampaign"
 ADD COLUMN "groundingRunStatus" TEXT NOT NULL DEFAULT 'IDLE',
 ADD COLUMN "groundingRunMaxSources" INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "groundingRunApprovedAt" TIMESTAMP(3),
 ADD COLUMN "groundingRunExpiresAt" TIMESTAMP(3);
ALTER TABLE "ResearchCampaignObservation"
 ADD COLUMN "groundingLeaseToken" TEXT,
 ADD COLUMN "groundingLeaseUntil" TIMESTAMP(3);

ALTER TABLE "ResearchCampaign"
 ADD CONSTRAINT "ResearchCampaign_groundingRunStatus_check"
 CHECK ("groundingRunStatus" IN ('IDLE','RUNNING','PAUSED','COMPLETED')),
 ADD CONSTRAINT "ResearchCampaign_groundingRunMaxSources_check"
 CHECK ("groundingRunMaxSources" BETWEEN 0 AND 250),
 ADD CONSTRAINT "ResearchCampaign_groundingRunAuthorization_check"
 CHECK (("groundingRunStatus" = 'IDLE' AND "groundingRunMaxSources" = 0
   AND "groundingRunApprovedAt" IS NULL AND "groundingRunExpiresAt" IS NULL)
 OR ("groundingRunStatus" <> 'IDLE' AND "groundingRunMaxSources" BETWEEN 1 AND 250
   AND "groundingRunApprovedAt" IS NOT NULL AND "groundingRunExpiresAt" IS NOT NULL));
ALTER TABLE "ResearchCampaignObservation"
 ADD CONSTRAINT "ResearchCampaignObservation_groundingLease_check"
 CHECK (("groundingLeaseToken" IS NULL AND "groundingLeaseUntil" IS NULL)
 OR ("groundingLeaseToken" IS NOT NULL AND "groundingLeaseUntil" IS NOT NULL
 AND "groundingStatus" = 'UNCHECKED'));
CREATE INDEX "ResearchCampaign_groundingRunStatus_groundingRunApprovedAt_idx"
 ON "ResearchCampaign" ("groundingRunStatus","groundingRunApprovedAt");
CREATE INDEX "ResearchCampaignObservation_grounding_claim_idx"
 ON "ResearchCampaignObservation" ("campaignId","groundingStatus","groundingLeaseUntil","id");
