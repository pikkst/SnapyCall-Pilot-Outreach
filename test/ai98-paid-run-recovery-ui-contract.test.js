import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ui = readFileSync(new URL("../web/main.tsx", import.meta.url), "utf8");
const research = ui.slice(ui.indexOf('{partnerTab === "discovery" && <>'),
  ui.indexOf('aria-label="Manual expert lead"'));

test("only server-managed approval can launch paid work on Research page", () => {
  assert.match(research, /campaignRunApproval\?\.autonomousRunEnabled &&/);
  assert.match(research, /!campaignRunApproval\.run &&/);
  assert.match(research, /"Approve single run"/);
  assert.doesNotMatch(research, /executeManualCampaignTask\(/);
  assert.doesNotMatch(research, /Run campaign until target or safety stop/);
  assert.doesNotMatch(research, /Run one search|Run ONE Gemini 3 Search cost test/);
});

test("paused run recovery opens separate free planning, never replays old spend", () => {
  const start = ui.indexOf('aria-label="Paused paid run recovery"');
  const end = ui.indexOf('aria-label="Approve a one-launch campaign"', start);
  assert.ok(start >= 0 && end > start);
  const panel = ui.slice(start, end);
  assert.match(ui.slice(start - 180, start), /campaignRunApproval\?\.run\?\.status === "PAUSED"/);
  assert.match(panel, /no automatic retry/i);
  assert.match(panel, /immutable paid-run/);
  assert.match(panel, /setCampaignCreationOpen\(true\)/);
  assert.match(panel, /Prepare a new campaign \(free\)/);
  assert.doesNotMatch(panel, /createManualTestCampaign\(|executeManualCampaignTask\(|execute-next/);
});
