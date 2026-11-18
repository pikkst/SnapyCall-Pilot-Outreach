-- Immutable per-campaign person-source research approval, separate from paid discovery.
CREATE TABLE "ResearchPersonSourceApproval" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
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
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ResearchPersonSourceApproval_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ResearchPersonSourceApproval_campaignId_key"
    ON "ResearchPersonSourceApproval"("campaignId");
CREATE INDEX "ResearchPersonSourceApproval_status_expiresAt_idx"
    ON "ResearchPersonSourceApproval"("status", "expiresAt");
CREATE INDEX "ResearchPersonSourceApproval_workspaceId_ownerId_idx"
    ON "ResearchPersonSourceApproval"("workspaceId", "ownerId");

ALTER TABLE "ResearchPersonSourceApproval"
    ADD CONSTRAINT "ResearchPersonSourceApproval_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "ResearchCampaign"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
