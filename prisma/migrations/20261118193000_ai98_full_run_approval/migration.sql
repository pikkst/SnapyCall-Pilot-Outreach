-- One explicit up-front research budget and public-inspection authorization.
-- This never authorizes contact promotion, mailbox validity or sending.
CREATE TABLE "ResearchFullRun" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "priceVersion" TEXT NOT NULL,
  "targetQualifiedContacts" INTEGER NOT NULL,
  "maxDiscoveryCalls" INTEGER NOT NULL,
  "maxSourceCalls" INTEGER NOT NULL,
  "maxEmailInspectionPages" INTEGER NOT NULL,
  "maxDiscoveryWorstCaseCents" INTEGER NOT NULL,
  "maxSourceWorstCaseCents" INTEGER NOT NULL,
  "maxTotalWorstCaseCents" INTEGER NOT NULL,
  "publicInspectionAuthorized" BOOLEAN NOT NULL DEFAULT false,
  "status" TEXT NOT NULL DEFAULT 'DISCOVERY',
  "lastCode" TEXT,
  "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ResearchFullRun_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ResearchFullRun_campaignId_key"
  ON "ResearchFullRun"("campaignId");
CREATE INDEX "ResearchFullRun_status_updatedAt_idx"
  ON "ResearchFullRun"("status","updatedAt");
CREATE INDEX "ResearchFullRun_workspaceId_ownerId_idx"
  ON "ResearchFullRun"("workspaceId","ownerId");
ALTER TABLE "ResearchFullRun"
  ADD CONSTRAINT "ResearchFullRun_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "ResearchCampaign"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
