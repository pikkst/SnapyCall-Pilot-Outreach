import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ui = readFileSync(new URL("../web/main.tsx", import.meta.url), "utf8");

test("manual executor is hidden when an immutable server run exists", () => {
  assert.match(ui, /campaignProgress\.operationalState === "READY" &&\s*campaignRunApproval\?\.run === null/);
  assert.match(ui, /campaignRunApproval\?\.autonomousRunEnabled &&/);
  assert.match(ui, /!campaignRunApproval\.run &&/);
  assert.match(ui, /"Approve single run"/);
});

test("paused paid run offers a new free plan rather than replay or second executor", () => {
  const start = ui.indexOf('aria-label="Paused paid run recovery"');
  const end = ui.indexOf('aria-label="Approve a one-launch campaign"', start);
  assert.ok(start >= 0 && end > start);
  const panel = ui.slice(start, end);
  assert.match(panel, /campaignRunApproval\?\.run\?\.status === "PAUSED"/);
  assert.match(panel, /no automatic retry/i);
  assert.match(panel, /immutable paid-run/);
  assert.match(panel, /createManualTestCampaign\(p\.id\)/);
  assert.doesNotMatch(panel, /executeManualCampaignTask\(/);
  assert.doesNotMatch(panel, /execute-next/);
});
