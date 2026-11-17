-- Existing campaigns are NOT implicitly authorized for background spending.
CREATE TABLE "ResearchCampaignRun" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "priceVersion" TEXT NOT NULL,
  "worstCasePerCallCents" INTEGER NOT NULL,
  "maxTasks" INTEGER NOT NULL,
  "maxWorstCaseCents" INTEGER NOT NULL,
  "startedTasks" INTEGER NOT NULL DEFAULT 0,
  "committedWorstCaseCents" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'APPROVED',
  "lastCode" TEXT,
  "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ResearchCampaignRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ResearchCampaignRun_maxTasks_check" CHECK ("maxTasks" BETWEEN 1 AND 24),
  CONSTRAINT "ResearchCampaignRun_maxWorstCaseCents_check"
    CHECK ("maxWorstCaseCents" > 0 AND "worstCasePerCallCents" > 0
      AND "maxWorstCaseCents" <= "maxTasks" * "worstCasePerCallCents"),
  CONSTRAINT "ResearchCampaignRun_counts_check"
    CHECK ("startedTasks" >= 0 AND "startedTasks" <= "maxTasks"
      AND "committedWorstCaseCents" >= 0
      AND "committedWorstCaseCents" <= "maxWorstCaseCents"),
  CONSTRAINT "ResearchCampaignRun_status_check"
    CHECK ("status" IN ('APPROVED','RUNNING','PAUSED','COMPLETED'))
);
CREATE UNIQUE INDEX "ResearchCampaignRun_campaignId_key" ON "ResearchCampaignRun"("campaignId");
CREATE INDEX "ResearchCampaignRun_status_approvedAt_idx" ON "ResearchCampaignRun"("status", "approvedAt");
CREATE INDEX "ResearchCampaignRun_workspaceId_ownerId_idx" ON "ResearchCampaignRun"("workspaceId", "ownerId");
ALTER TABLE "ResearchCampaignRun" ADD CONSTRAINT "ResearchCampaignRun_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "ResearchCampaign"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
