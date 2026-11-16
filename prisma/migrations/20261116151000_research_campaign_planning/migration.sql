-- Research campaign planning is inert: these rows do not trigger API calls.
CREATE TABLE "ResearchCampaign" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "query" TEXT NOT NULL,
  "targetCount" INTEGER NOT NULL,
  "planVersion" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ResearchCampaign_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ResearchCampaign_workspaceId_fkey" FOREIGN KEY ("workspaceId")
    REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ResearchCampaign_workspaceId_ownerId_idempotencyKey_key"
  ON "ResearchCampaign"("workspaceId", "ownerId", "idempotencyKey");
CREATE INDEX "ResearchCampaign_workspaceId_createdAt_idx"
  ON "ResearchCampaign"("workspaceId", "createdAt");
CREATE INDEX "ResearchCampaign_status_createdAt_idx"
  ON "ResearchCampaign"("status", "createdAt");

CREATE TABLE "ResearchCampaignTask" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "taskIndex" INTEGER NOT NULL,
  "taskKey" TEXT NOT NULL,
  "query" TEXT NOT NULL,
  "region" TEXT NOT NULL,
  "facet" TEXT NOT NULL,
  "resultLimit" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ResearchCampaignTask_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ResearchCampaignTask_campaignId_fkey" FOREIGN KEY ("campaignId")
    REFERENCES "ResearchCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ResearchCampaignTask_campaignId_taskIndex_key"
  ON "ResearchCampaignTask"("campaignId", "taskIndex");
CREATE UNIQUE INDEX "ResearchCampaignTask_campaignId_taskKey_key"
  ON "ResearchCampaignTask"("campaignId", "taskKey");
CREATE INDEX "ResearchCampaignTask_status_createdAt_idx"
  ON "ResearchCampaignTask"("status", "createdAt");
