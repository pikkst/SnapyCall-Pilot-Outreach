import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ui = readFileSync(new URL("../web/main.tsx", import.meta.url), "utf8");

test("single and 100-candidate research reuse the same criteria without a paid launch", () => {
  assert.match(ui, /Plan 100-candidate campaign \(free\)/);
  assert.match(ui, /setCampaignTestQuery\(researchQuery\.trim\(\)\)/);
  assert.match(ui, /setPartnerTab\("dashboard"\)/);
  assert.match(ui, /campaignCreateIdempotency\.current = null/);
  assert.match(ui, /researchQuery\.trim\(\)\.length > 240/);
  // The existing free planning route, not a second research endpoint.
  assert.match(ui, /targetCount: 100, idempotencyKey/);
  assert.match(ui, /"\/research-campaigns\?workspaceId="/);
});

test("100-candidate planning shares readiness and does not claim verified contacts", () => {
  const campaigns = ui.split('<div className="campaign-overview">')[1]
    ?.split('{campaignListStatus === "error"')[0];
  assert.ok(campaigns, "campaign overview is present");
  assert.match(campaigns, /readiness\.steps\.map\(step/);
  assert.match(campaigns, /readiness\.ready/);
  assert.match(campaigns, /setPartnerTab\("settings"\)/);
  assert.match(campaigns, /A cited candidate/);
  assert.match(campaigns, /Sheets sync is not active/);
  assert.match(campaigns, /outreach stays disabled/);
});

test("one search retains exact existing server budget and review requirements", () => {
  assert.match(ui, /!readiness\.ready/);
  assert.match(ui, /runResearch\(p\.id, event\)/);
  assert.match(ui, /researchBudget\.enforcedForPaidSearch/);
  assert.match(ui, /reviewedResearchSources/);
  assert.match(ui, /No invitations are sent/);
});
