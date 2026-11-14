-- Per-owner preferences are independent of provider and workspace.
-- The hard workspace cap remains server-controlled.
CREATE TABLE "ResearchUserLimits" (
  "ownerId" TEXT NOT NULL,
  "dailyLimit" INTEGER NOT NULL DEFAULT 2,
  "maxCandidates" INTEGER NOT NULL DEFAULT 10,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ResearchUserLimits_pkey" PRIMARY KEY ("ownerId"),
  CONSTRAINT "ResearchUserLimits_dailyLimit_check" CHECK ("dailyLimit" BETWEEN 1 AND 100),
  CONSTRAINT "ResearchUserLimits_maxCandidates_check" CHECK ("maxCandidates" BETWEEN 1 AND 20)
);
