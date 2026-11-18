-- Raise the former fixed 100/day safety ceiling to an administrator-owned
-- per-workspace setting. Existing and new workspaces start with 1000/day.
-- Do not rewrite ResearchDailyQuota counts, reservations or provider calls.
ALTER TABLE "Partner"
ADD COLUMN "researchDailyLimit" INTEGER NOT NULL DEFAULT 1000;

ALTER TABLE "Partner"
ADD CONSTRAINT "Partner_researchDailyLimit_range"
CHECK ("researchDailyLimit" BETWEEN 1 AND 1000);

-- The previous hard-coded personal ceiling was enforced by a DB CHECK
-- constraint (not only by Zod). Upgrade it in the same migration.
ALTER TABLE "ResearchUserLimits"
DROP CONSTRAINT IF EXISTS "ResearchUserLimits_dailyLimit_check";
ALTER TABLE "ResearchUserLimits"
ADD CONSTRAINT "ResearchUserLimits_dailyLimit_check"
CHECK ("dailyLimit" BETWEEN 1 AND 1000);
