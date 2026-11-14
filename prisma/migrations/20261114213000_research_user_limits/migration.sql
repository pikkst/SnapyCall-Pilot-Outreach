-- Per-owner preferences are independent of provider and workspace.
-- The hard workspace cap remains server-controlled.
CREATE TABLE "ResearchUserLimits" (
  "ownerId" TEXT NOT NULL,
  "dailyLimit" INTEGER NOT NULL DEFAULT 2,
  "maxCandidates" INTEGER NOT NULL DEFAULT 10,
  "maxConcurrent" INTEGER NOT NULL DEFAULT 1,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ResearchUserLimits_pkey" PRIMARY KEY ("ownerId"),
  CONSTRAINT "ResearchUserLimits_dailyLimit_check" CHECK ("dailyLimit" BETWEEN 1 AND 100),
  CONSTRAINT "ResearchUserLimits_maxCandidates_check" CHECK ("maxCandidates" BETWEEN 1 AND 20),
  CONSTRAINT "ResearchUserLimits_maxConcurrent_check" CHECK ("maxConcurrent" BETWEEN 1 AND 3)
);

CREATE TABLE "ResearchRunLease" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "releasedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ResearchRunLease_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ResearchRunLease_workspaceId_expiresAt_idx"
  ON "ResearchRunLease" ("workspaceId", "expiresAt");
CREATE INDEX "ResearchRunLease_workspaceId_userId_expiresAt_idx"
  ON "ResearchRunLease" ("workspaceId", "userId", "expiresAt");
