import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ui = readFileSync(new URL("../web/main.tsx", import.meta.url), "utf8");

test("full-run automatically opens its owner-scoped read-only manifest once after terminal completion", () => {
  const start = ui.indexOf("// The approved full run performs all intermediate stages server-side.");
  const end = ui.indexOf("// Read-only server progress refresh", start);
  assert.ok(start > 0 && end > start);
  const effect = ui.slice(start, end);
  assert.match(effect, /\["PARTIAL", "READY_FOR_REVIEW", "COMPLETED"\]/);
  assert.match(effect, /campaignRunApproval\?\.fullRun\?\.status/);
  assert.match(effect, /campaignProgress\?\.status/);
  assert.match(effect, /autoQualifiedManifestRequested\.current === key/);
  assert.match(effect, /autoQualifiedManifestRequested\.current = key/);
  assert.match(effect, /loadQualifiedContactManifest\(activeWorkspaceId, campaignProgressId\)/);
  assert.doesNotMatch(effect, /approveQualifiedContactBatchFromManifest|startResearch|runOneCampaignTask/);
  assert.match(ui, /autoQualifiedManifestRequested\.current = null/);
});

test("the only successful full-run human checkpoint reviews exact pairs and cannot enable sending", () => {
  assert.match(ui, /Contact list ready for confirmation/);
  assert.match(ui, /Confirm contact list/);
  assert.match(ui, /qualifiedBatchConfirmed/);
  assert.match(ui, /manifestHash: qualifiedManifest\.manifestHash/);
  assert.match(ui, /confirmEveryDisplayedPair: true/);
  assert.match(ui, /confirmNoAutomaticSending: true/);
  assert.match(ui, /No sufficiently attributed public person-email/);
  assert.match(ui, /There is no list to confirm/);
});
