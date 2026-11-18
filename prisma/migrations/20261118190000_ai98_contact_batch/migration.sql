-- Durable, evidence-manifest-bound batch contact review. No automatic sending.
CREATE TABLE "ResearchContactBatch" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "manifestHash" CHAR(64) NOT NULL,
  "itemCount" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'APPROVED',
  "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ResearchContactBatch_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ResearchContactBatch_campaignId_key"
  ON "ResearchContactBatch"("campaignId");
CREATE INDEX "ResearchContactBatch_status_updatedAt_idx"
  ON "ResearchContactBatch"("status", "updatedAt");
CREATE INDEX "ResearchContactBatch_workspaceId_ownerId_idx"
  ON "ResearchContactBatch"("workspaceId", "ownerId");
ALTER TABLE "ResearchContactBatch" ADD CONSTRAINT "ResearchContactBatch_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "ResearchCampaign"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ResearchContactBatchItem" (
  "id" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "observationId" TEXT NOT NULL,
  "expectedDigest" CHAR(64) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "leaseToken" UUID,
  "leaseUntil" TIMESTAMP(3),
  "resultCode" TEXT,
  "candidateId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ResearchContactBatchItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ResearchContactBatchItem_observationId_key"
  ON "ResearchContactBatchItem"("observationId");
CREATE INDEX "ResearchContactBatchItem_batchId_status_createdAt_idx"
  ON "ResearchContactBatchItem"("batchId","status","createdAt");
ALTER TABLE "ResearchContactBatchItem" ADD CONSTRAINT "ResearchContactBatchItem_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "ResearchContactBatch"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ResearchContactBatchItem" ADD CONSTRAINT "ResearchContactBatchItem_observationId_fkey"
  FOREIGN KEY ("observationId") REFERENCES "ResearchCampaignObservation"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
