import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const code = readFileSync(new URL("../web/main.tsx", import.meta.url), "utf8");

test("grounding stage is owner-confirmed and isolated from AI / email work", () => {
  assert.match(code, /confirmPublicRequests: true/);
  assert.match(code, /campaignGroundingConfirmed/);
  assert.match(code, /!campaignGroundingConfirmed\s*\|\|\s*campaignGroundingBusy/);
  assert.match(code, /campaignGrounding\.enabled/);
  assert.match(code, /"\/grounding\?workspaceId="/);
  assert.match(code, /"\/grounding\/" \+ action/);
  assert.match(code, /A resolved link is an unverified source hint/);
  assert.match(code, /Previously dispatched requests will not be/);
});

test("grounding progress is scoped and reset on campaign and workspace changes", () => {
  assert.match(code, /generation === workspaceRequest\.current\s*&&\s*request === campaignProgressRequest\.current/);
  assert.match(code, /void loadCampaignGrounding\(activeWorkspaceId, campaignProgressId\)/);
  assert.match(code, /void loadCampaignGrounding\(workspaceId, campaignId\)/);
  assert.ok((code.match(/setCampaignGrounding\(null\)/g) ?? []).length >= 3);
  assert.match(code, /aria-label="Grounding source resolution progress"/);
  assert.match(code, /max=\{Math\.max\(1, campaignGrounding\.maxSources\)\}/);
});

test("grounding UX cannot authorize contact creation or outreach", () => {
  const panel = code.split('aria-label="Google source resolution agent"')[1]
    ?.split('aria-label="Stored public email inspection results"')[0];
  assert.ok(panel, "grounding stage panel must exist before email triage");
  assert.doesNotMatch(panel, /sendOutreach|createCandidate|acceptReviewedCampaignContact/);
  assert.match(panel, /Source resolution is paused/);
});
