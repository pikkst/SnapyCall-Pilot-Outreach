-- Task state coordination only; execution and paid provider calls remain disabled.
ALTER TABLE "ResearchCampaignTask"
  ADD COLUMN "leaseToken" TEXT,
  ADD COLUMN "leaseUntil" TIMESTAMP(3),
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3),
  ADD COLUMN "lastErrorCode" TEXT,
  ADD COLUMN "observedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "completedAt" TIMESTAMP(3);

DROP INDEX "ResearchCampaignTask_status_createdAt_idx";
CREATE INDEX "ResearchCampaignTask_status_nextAttemptAt_leaseUntil_idx"
  ON "ResearchCampaignTask"("status", "nextAttemptAt", "leaseUntil");
