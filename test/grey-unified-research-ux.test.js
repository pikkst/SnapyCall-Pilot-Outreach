import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ui = readFileSync(new URL("../web/main.tsx", import.meta.url), "utf8");
const researchStart = ui.indexOf('{partnerTab === "discovery" && <>');
const manualStart = ui.indexOf('aria-label="Manual expert lead"', researchStart);
const researchPanel = ui.slice(researchStart, manualStart);

test("Research exposes one server-managed campaign, not multiple paid search launchers", () => {
  assert.ok(researchStart > 0 && manualStart > researchStart);
  assert.match(researchPanel, /aria-label="Campaign navigation"/);
  assert.match(researchPanel, /<div className="campaign-overview">/);
  assert.match(researchPanel, /aria-label="Campaign research progress"/);
  assert.match(researchPanel, /Approve single run/);
  assert.doesNotMatch(researchPanel, /Run one search|Run ONE Gemini 3 Search cost test/);
  assert.doesNotMatch(researchPanel, /Run campaign until target or safety stop/);
  assert.doesNotMatch(researchPanel, /executeManualCampaignTask\(/);
  assert.doesNotMatch(researchPanel, /Choose research mode|researchMode ===/);
});

test("existing campaigns open read-only and retain selected tenant context", () => {
  assert.match(ui, /autoOpenedCampaignForWorkspace\.current === activeWorkspaceId/);
  assert.match(ui, /partnerTab !== "discovery"/);
  assert.match(ui, /campaignListStatus !== "ready"/);
  assert.match(ui, /Date\.parse\(b\.createdAt\) - Date\.parse\(a\.createdAt\)/);
  assert.match(ui, /void openCampaignProgress\(activeWorkspaceId, latest\.id\)/);
  assert.match(ui, /setCampaignTestQuery\(latest\.query\)/);
  assert.match(ui, /Number\(b\.status === "RUNNING"\)/);
  assert.match(researchPanel, /setCampaignTestQuery\(selected\.query\)/);
  assert.match(ui, /if \(activeWorkspaceId !== workspaceId\) return/);
  assert.match(researchPanel, /value=\{campaignProgressId \?\? ""\}/);
  assert.match(researchPanel, /openCampaignProgress\(p\.id, event\.target\.value\)/);
});

test("new campaign planning is free, idempotent, and separate from approval", () => {
  assert.match(researchPanel, /Plan new campaign \(free\)/);
  assert.match(researchPanel, /campaignCreationOpen \|\| workspaceCampaigns\.length === 0/);
  assert.match(researchPanel, /Plan campaign \(free\)/);
  assert.match(ui, /targetCount: 100, idempotencyKey/);
  assert.match(ui, /campaignCreateIdempotency\.current \?\?/);
  assert.match(ui, /"\/research-campaigns\?workspaceId="/);
  assert.match(researchPanel, /campaignRunApproval\?\.priceEnvelope|campaignRunApproval\.priceEnvelope/);
  assert.match(researchPanel, /I approve this maximum reserve/);
  assert.match(researchPanel, /No emails are sent/);
});

test("one Research workspace keeps explicit review and optional settings", () => {
  assert.match(researchPanel, /readiness\.steps\.map\(step/);
  assert.match(researchPanel, /setPartnerTab\("settings"\)/);
  assert.match(researchPanel, /Sheets sync is not active/);
  assert.match(researchPanel, /outreach stays disabled/);
  assert.match(ui, /aria-label="Manual expert lead"/);
  const ai = ui.indexOf('aria-label="Personal AI configuration"');
  const limits = ui.indexOf('aria-label="Personal AI research limits"');
  const budget = ui.indexOf('aria-label="Personal AI monthly budget"');
  const gmail = ui.indexOf('aria-label="Personal Gmail sending authorization"');
  assert.ok(ai >= 0 && ai < limits && limits < budget && budget < gmail);
});
