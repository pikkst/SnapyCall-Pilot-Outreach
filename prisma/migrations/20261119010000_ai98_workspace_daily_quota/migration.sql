-- Raise the former fixed 100/day safety ceiling to an administrator-owned
-- per-workspace setting. Existing and new workspaces start with 1000/day.
-- Do not rewrite ResearchDailyQuota counts, reservations or provider calls.
ALTER TABLE "Partner"
ADD COLUMN "researchDailyLimit" INTEGER NOT NULL DEFAULT 1000;

ALTER TABLE "Partner"
ADD CONSTRAINT "Partner_researchDailyLimit_range"
CHECK ("researchDailyLimit" BETWEEN 1 AND 1000);
