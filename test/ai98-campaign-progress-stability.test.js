import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ui = readFileSync(new URL("../web/main.tsx", import.meta.url), "utf8");

test("campaign picker and run summary precede live progress with preserved tenant selection", () => {
  const picker = ui.indexOf('aria-label="Campaign navigation"');
  const summary = ui.indexOf('aria-label="Selected campaign summary"', picker);
  const panel = ui.indexOf('aria-label="Campaign research progress"', summary);
  assert.ok(picker >= 0 && summary > picker && panel > summary);
  assert.match(ui, /<select value=\{campaignProgressId \?\? ""\}/);
  assert.match(ui, /onChange=\{event => \{[\s\S]*?openCampaignProgress\(p\.id, event\.target\.value\)/);
  assert.match(ui, /Research is paused\. A possibly billable task needs/);
  assert.match(ui, /The remaining queued tasks/);
  assert.match(ui, /No source-backed candidates yet:/);
  assert.doesNotMatch(ui, /className="research-campaign-history"/);
});

test("read-only progress refresh stays in place and is fenced to workspace", () => {
  const refreshStart = ui.indexOf("async function refreshSelectedCampaignProgress(");
  const refreshEnd = ui.indexOf("async function loadCampaignObservations(", refreshStart);
  const refresh = ui.slice(refreshStart, refreshEnd);
  assert.ok(refreshStart >= 0 && refreshEnd > refreshStart);
  assert.match(refresh, /campaignProgressId !== campaignId/);
  assert.match(refresh, /request !== campaignProgressRequest\.current/);
  assert.match(refresh, /setCampaignProgress\(progress\)/);
  assert.doesNotMatch(refresh, /setCampaignProgress\(null\)|setCampaignProgressStatus\("loading"\)/);
  assert.match(ui, /window\.setInterval\(\(\) => void refresh\(\), 6_000\)/);
});

test("uncertain billed request is not auto-retried and cannot launch second UI runner", () => {
  assert.match(ui, /campaignProgress\.operationalState === "PAUSED_REVIEW"/);
  assert.match(ui, /Do not reattempt this paid request/);
  assert.match(ui, /no verifiable citations/);
  const panel = ui.slice(ui.indexOf('aria-label="Campaign navigation"'),
    ui.indexOf('aria-label="Manual expert lead"'));
  assert.doesNotMatch(panel, /Run campaign until target or safety stop/);
});
