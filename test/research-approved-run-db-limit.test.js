import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateCampaignRunApproval } from "../server/research-campaign-run-approval.js";

// Runtime accepted 250 after AI98, but PostgreSQL still enforced <=24.
// Lock the *runtime + migration* contract together, so clean-start and
// upgraded databases cannot silently diverge again.
const sql = readFileSync(new URL(
  "../prisma/migrations/20261118214500_ai98_approved_run_task_limit_250/migration.sql",
  import.meta.url,
), "utf8");

test("approved-run API accepts 25, 50, 100 and 250 tasks within frozen spend", () => {
  for (const maxTasks of [25, 50, 100, 250]) {
    const authorized = validateCampaignRunApproval({
      maxTasks,
      maxWorstCaseCents: maxTasks * 3,
      confirmConservativeBudget: true,
      confirmNoAutomaticRetry: true,
    });
    assert.equal(authorized.maxTasks, maxTasks);
  }
  for (const maxTasks of [0, 251]) {
    assert.throws(() => validateCampaignRunApproval({
      maxTasks, maxWorstCaseCents: 150,
      confirmConservativeBudget: true,
      confirmNoAutomaticRetry: true,
    }), TypeError);
  }
});

test("additive migration widens existing Postgres CHECK to exactly 1..250", () => {
  assert.match(sql,
    /DROP CONSTRAINT "ResearchCampaignRun_maxTasks_check"/);
  assert.match(sql,
    /ADD CONSTRAINT "ResearchCampaignRun_maxTasks_check"/);
  assert.match(sql, /"maxTasks" >= 1 AND "maxTasks" <= 250/);
  assert.doesNotMatch(sql, /DROP TABLE|DELETE FROM|TRUNCATE|UPDATE\s+"ResearchCampaignRun"/i);
});
