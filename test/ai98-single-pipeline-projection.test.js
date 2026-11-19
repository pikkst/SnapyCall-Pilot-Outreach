import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ui = readFileSync(new URL("../web/main.tsx", import.meta.url), "utf8");

test("approved full-run uses one authoritative pipeline instead of legacy manual-only stages", () => {
  assert.match(ui, /\{!campaignRunApproval\?\.fullRun &&\s*<section className="campaign-stage-timeline"/);
  assert.match(ui, /campaignStageTimeline\(campaignProgress\)/);
  assert.match(ui, /campaignRunApproval\?\.stageProgress\?\.\[stage\.key\]/);
  assert.match(ui, /aria-label="Research pipeline timers"/);
});

test("discovery-only next-action and optional Google redirect are not mistaken for active full run", () => {
  assert.match(ui, /\{!campaignRunApproval\?\.fullRun &&\s*<p className="muted">Discovery next step:/);
  assert.match(ui, /Optional Google redirect resolver/);
  assert.match(ui, /not the paid\s*Source enrichment stage/);
  assert.doesNotMatch(ui, /<strong>Source resolution agent<\/strong>/);
  assert.doesNotMatch(ui, /<p className="muted">Next step: \{campaignProgress\.action\}/);
});

test("legacy discovery-only timeline remains available without weakening contact or sending fences", () => {
  assert.match(ui, /Legacy discovery campaign stages/);
  assert.match(ui, /campaignStageTimeline\(campaignProgress\)/);
  assert.match(ui, /confirmNoAutomaticSending: true/);
});
