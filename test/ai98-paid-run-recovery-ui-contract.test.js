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

test("exhausted budget displays successful bound rather than provider failure", () => {
  const start = ui.indexOf('aria-label="Paid campaign run outcome"');
  const end = ui.indexOf('aria-label="Approve a one-launch campaign"', start);
  assert.ok(start >= 0 && end > start);
  const outcome = ui.slice(start, end);
  assert.match(outcome, /lastCode === "RUN_LIMIT_REACHED"/);
  assert.match(outcome, /Approved research limit reached successfully/);
  assert.match(outcome, /not a[\s\S]*provider failure/);
  assert.match(outcome, /role=\{campaignRunApproval\.run\.lastCode === "RUN_LIMIT_REACHED"/);
  assert.match(outcome, /status" : "alert"/);
});

test("uncertain paused run cannot replay and offers a fresh free campaign", () => {
  const start = ui.indexOf('aria-label="Paid campaign run outcome"');
  const end = ui.indexOf('aria-label="Approve a one-launch campaign"', start);
  assert.ok(start >= 0 && end > start);
  const panel = ui.slice(start, end);
  assert.match(ui.slice(start - 350, start),
    /campaignRunApproval\.run\.status === "PAUSED"/);
  assert.match(panel, /Research stopped safely — no automatic retry/);
  assert.match(panel, /will not be repeated automatically/);
  assert.match(panel, /setCampaignCreationOpen\(true\)/);
  assert.match(panel, /Prepare a new campaign \(free\)/);
  assert.doesNotMatch(panel, /createManualTestCampaign\(|executeManualCampaignTask\(|execute-next/);
});
