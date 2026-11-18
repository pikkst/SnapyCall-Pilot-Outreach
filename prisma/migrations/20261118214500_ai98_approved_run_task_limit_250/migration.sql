-- AI98: the API and approved-run ledger support 1..250 independently
-- metered discovery tasks, but the original DB CHECK still allows only 1..24.
-- Replace the old bound without touching existing approvals or billing rows.
-- The existing counts / worst-case-spend CHECK constraints remain unchanged.
ALTER TABLE "ResearchCampaignRun"
  DROP CONSTRAINT "ResearchCampaignRun_maxTasks_check";

ALTER TABLE "ResearchCampaignRun"
  ADD CONSTRAINT "ResearchCampaignRun_maxTasks_check"
  CHECK ("maxTasks" >= 1 AND "maxTasks" <= 250);
