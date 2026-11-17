import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ui = readFileSync(new URL("../web/main.tsx", import.meta.url), "utf8");

test("only typed exact 429 no-dispatch response can continue a paid run", () => {
  assert.match(ui, /response\.status === 429 && info\?\.code === "RESEARCH_PACING_WAIT"/);
  assert.match(ui, /Number\.isInteger\(info\.retryAfterSeconds\)/);
  assert.match(ui, /throw new ResearchPacingWait\(info\.retryAfterSeconds!\)/);
  assert.match(ui, /import \{ runApprovedCampaignBatch, ResearchPacingWait \}/);
});

test("browser campaign keeps one consent and leaves unknown outcomes un-replayed", () => {
  const start = ui.indexOf("async function executeManualCampaignTask(");
  const end = ui.indexOf("async function skipUncertainCampaignTask(", start);
  const batch = ui.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(batch, /runApprovedCampaignBatch\(\{/);
  assert.match(batch, /maxTasks: approvedMaxTasks/);
  assert.match(batch, /shouldStop: \(\) => batchStopRequested\.current/);
  assert.match(batch, /method: "POST", body: JSON\.stringify\(\{ maxTasks: 1 \}\)/);
  assert.match(batch, /await refreshSelectedCampaignProgress\(workspaceId, campaignId\)/);
  assert.doesNotMatch(batch, /retry.*BILLING_UNCERTAIN|skipUncertainCampaignTask\(/);
});
