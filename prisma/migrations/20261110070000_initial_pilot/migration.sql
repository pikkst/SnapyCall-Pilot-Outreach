CREATE TABLE "Candidate" (
"id" TEXT NOT NULL, "kind" TEXT NOT NULL DEFAULT 'EXPERT', "name" TEXT NOT NULL, "email" TEXT, "emailNormalized" TEXT,
"category" TEXT NOT NULL, "region" TEXT, "onlineEnglish" BOOLEAN NOT NULL DEFAULT false, "sourceUrl" TEXT NOT NULL,
"sourceCollectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "legalBasis" TEXT, "contactReviewed" BOOLEAN NOT NULL DEFAULT false,
"suppressed" BOOLEAN NOT NULL DEFAULT false, "status" TEXT NOT NULL DEFAULT 'NEW',
"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
CONSTRAINT "Candidate_pkey" PRIMARY KEY ("id"));
CREATE TABLE "AiSetting" (
"id" TEXT NOT NULL, "ownerId" TEXT NOT NULL, "provider" TEXT NOT NULL, "model" TEXT NOT NULL, "encryptedApiKey" TEXT NOT NULL,
"keyFingerprint" TEXT NOT NULL, "updatedAt" TIMESTAMP(3) NOT NULL,
CONSTRAINT "AiSetting_pkey" PRIMARY KEY ("id"));
CREATE TABLE "OutreachDraft" (
"id" TEXT NOT NULL, "candidateId" TEXT NOT NULL, "subject" TEXT NOT NULL, "body" TEXT NOT NULL, "model" TEXT NOT NULL,
"provider" TEXT NOT NULL, "approvedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
CONSTRAINT "OutreachDraft_pkey" PRIMARY KEY ("id"));
CREATE TABLE "AuditEvent" (
"id" TEXT NOT NULL, "actorId" TEXT NOT NULL, "action" TEXT NOT NULL, "entityId" TEXT,
"metadata" JSONB, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "Candidate_emailNormalized_key" ON "Candidate"("emailNormalized");
CREATE INDEX "Candidate_category_status_idx" ON "Candidate"("category", "status");
CREATE UNIQUE INDEX "AiSetting_ownerId_key" ON "AiSetting"("ownerId");
CREATE INDEX "OutreachDraft_candidateId_createdAt_idx" ON "OutreachDraft"("candidateId", "createdAt");
CREATE INDEX "AuditEvent_action_createdAt_idx" ON "AuditEvent"("action", "createdAt");
ALTER TABLE "OutreachDraft" ADD CONSTRAINT "OutreachDraft_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
