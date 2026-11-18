import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ui = readFileSync(new URL("../web/main.tsx", import.meta.url), "utf8");
const server = readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
const approval = readFileSync(new URL("../server/research-campaign-run-approval.js", import.meta.url), "utf8");

test("campaign GET returns owner-scoped UTC quota capacity without external provider calls", () => {
  const route = server.slice(
    server.indexOf('app.get("/api/research-campaigns/:id/approved-run"'),
    server.indexOf('app.post("/api/research-campaigns/:id/execute-next"'),
  );
  assert.match(route, /candidateReadScope/);
  assert.match(route, /ownerId: identity\.id/);
  assert.match(route, /readResearchDailyCapacity\(prisma/);
  assert.match(route, /dailyQuota,/);
  assert.match(route, /"no-store"/);
});

test("preflight rejects oversized full-run before any approval is created", () => {
  const guarded = approval.slice(
    approval.indexOf('if (attempts !== 0 || observations !== 0)'),
    approval.indexOf('const created = await tx.researchCampaignRun.create'),
  );
  assert.match(guarded, /limits\.maxTasks \+ fullRun\.maxSourceCalls/);
  assert.match(guarded, /requestedCalls > dailyQuota\.remaining/);
  assert.match(guarded, /DAILY_QUOTA_INSUFFICIENT/);
});

test("Research warns before start, disables approval and links to the correct setting", () => {
  const panel = ui.slice(
    ui.indexOf('aria-label="Approve a one-launch campaign"'),
    ui.indexOf('aria-label="Saved campaign findings"'),
  );
  assert.match(panel, /Daily research limit would be exceeded/);
  assert.match(panel, /campaignMaxTasks \+ campaignSourceCalls/);
  assert.match(panel, /campaignRunApproval\.dailyQuota\.remaining/);
  assert.match(panel, /resetsAt/);
  assert.match(panel, /Open research limit settings/);
  assert.match(panel, /setPartnerTab\("settings"\)/);
  assert.match(panel, /disabled=\{!campaignNoReplayConfirmed/);
  assert.match(panel, /!campaignRunApproval\.dailyQuota/);
  assert.match(ui, /id="research-daily-limit-settings"/);
  const onClick = ui.slice(
    ui.indexOf("async function approveCampaignAutonomousRun"),
    ui.indexOf("async function loadCampaignGrounding"),
  );
  assert.ok(onClick.indexOf("/approved-run?workspaceId=") <
    onClick.indexOf("/approve-run?workspaceId="));
  assert.match(onClick, /requested > fresh\.dailyQuota\.remaining/);
});
