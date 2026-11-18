-- Durable research-only queue. No provider dispatch or Candidate promotion.
CREATE TABLE "ResearchPersonSourceJob" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "observationId" TEXT NOT NULL,
    "evidenceFingerprint" CHAR(64) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ResearchPersonSourceJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ResearchPersonSourceJob_observationId_key"
    ON "ResearchPersonSourceJob"("observationId");
CREATE INDEX "ResearchPersonSourceJob_campaignId_status_createdAt_idx"
    ON "ResearchPersonSourceJob"("campaignId", "status", "createdAt");
CREATE INDEX "ResearchPersonSourceJob_status_leaseUntil_idx"
    ON "ResearchPersonSourceJob"("status", "leaseUntil");

ALTER TABLE "ResearchPersonSourceJob"
    ADD CONSTRAINT "ResearchPersonSourceJob_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "ResearchCampaign"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchPersonSourceJob"
    ADD CONSTRAINT "ResearchPersonSourceJob_observationId_fkey"
    FOREIGN KEY ("observationId") REFERENCES "ResearchCampaignObservation"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
