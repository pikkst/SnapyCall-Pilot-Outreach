-- Continuation cycles preserve the first immutable source approval and every
-- historic charge. Each observation may be assigned to one cycle only.
ALTER TABLE "ResearchPersonSourceJob"
  ADD COLUMN "cycleIndex" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "ResearchPersonSourceJob_campaignId_cycleIndex_status_idx"
  ON "ResearchPersonSourceJob"("campaignId","cycleIndex","status");

CREATE TABLE "ResearchPersonSourceCycle" (
 "id" TEXT NOT NULL,
 "campaignId" TEXT NOT NULL,
 "workspaceId" TEXT NOT NULL,
 "ownerId" TEXT NOT NULL,
 "cycleIndex" INTEGER NOT NULL,
 "provider" TEXT NOT NULL,
 "model" TEXT NOT NULL,
 "priceVersion" TEXT NOT NULL,
 "worstCasePerCallCents" INTEGER NOT NULL,
 "maxCalls" INTEGER NOT NULL,
 "maxWorstCaseCents" INTEGER NOT NULL,
 "eligibleJobCount" INTEGER NOT NULL,
 "jobSnapshotHash" CHAR(64) NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'APPROVED',
 "startedCalls" INTEGER NOT NULL DEFAULT 0,
 "committedWorstCaseCents" INTEGER NOT NULL DEFAULT 0,
 "expiresAt" TIMESTAMP(3) NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "ResearchPersonSourceCycle_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ResearchPersonSourceCycle_campaignId_cycleIndex_key"
 ON "ResearchPersonSourceCycle"("campaignId","cycleIndex");
CREATE INDEX "ResearchPersonSourceCycle_status_updatedAt_idx"
 ON "ResearchPersonSourceCycle"("status","updatedAt");
CREATE INDEX "ResearchPersonSourceCycle_workspaceId_ownerId_idx"
 ON "ResearchPersonSourceCycle"("workspaceId","ownerId");
ALTER TABLE "ResearchPersonSourceCycle" ADD CONSTRAINT
 "ResearchPersonSourceCycle_campaignId_fkey"
 FOREIGN KEY ("campaignId") REFERENCES "ResearchCampaign"("id")
 ON DELETE RESTRICT ON UPDATE CASCADE;
