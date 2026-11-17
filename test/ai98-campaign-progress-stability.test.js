import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ui = readFileSync(new URL("../web/main.tsx", import.meta.url), "utf8");

test("campaign progress is above collapsed history and preserves selected context", () => {
  const panel = ui.indexOf('aria-label="Campaign research progress"');
  const history = ui.indexOf('className="research-campaign-history"');
  assert.ok(panel >= 0 && history > panel);
  assert.match(ui, /<summary>Campaign history \(\{workspaceCampaigns\.length\}\)<\/summary>/);
  assert.equal(ui.split('className="research-campaign-history"').length - 1, 1);
  assert.match(ui, /Research is paused\. A possibly billable task needs/);
  assert.match(ui, /The remaining queued tasks/);
  assert.match(ui, /No source-backed candidates yet:/);
});

test("finishing a paid batch refreshes the current panel in-place, not remounts it", () => {
  const start = ui.indexOf("async function executeManualCampaignTask(");
  const end = ui.indexOf("async function skipUncertainCampaignTask(", start);
  const batch = ui.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(batch, /await refreshSelectedCampaignProgress\(workspaceId, campaignId\)/);
  assert.doesNotMatch(batch, /await openCampaignProgress\(workspaceId, campaignId\)/);
  const refreshStart = ui.indexOf("async function refreshSelectedCampaignProgress(");
  const refreshEnd = ui.indexOf("async function loadCampaignObservations(", refreshStart);
  const refresh = ui.slice(refreshStart, refreshEnd);
  assert.ok(refreshStart >= 0 && refreshEnd > refreshStart);
  assert.match(refresh, /campaignProgressId !== campaignId/);
  assert.match(refresh, /request !== campaignProgressRequest\.current/);
  assert.match(refresh, /setCampaignProgress\(progress\)/);
  assert.doesNotMatch(refresh, /setCampaignProgress\(null\)|setCampaignProgressStatus\("loading"\)/);
});

test("unknown billed request remains blocked, not a misleading active run", () => {
  assert.match(ui, /campaignProgress\.operationalState === "PAUSED_REVIEW"/);
  assert.match(ui, /Do not reattempt this paid request/);
  assert.match(ui, /no verifiable citations/);
});
