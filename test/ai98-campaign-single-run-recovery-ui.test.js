import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ui = readFileSync(new URL("../web/main.tsx", import.meta.url), "utf8");

test("manual batch cannot launch while a server-managed run authorization exists", () => {
  assert.match(ui, /campaignProgress\.operationalState === "READY" &&\s*campaignRunApproval\?\.run === null/);
  assert.match(ui, /Run campaign until target or safety stop/);
  assert.match(ui, /RUN_REQUIRES_AUTONOMOUS_EXECUTOR/); // server remains authoritative
});

test("paused run offers safe fresh-plan recovery without replaying uncertain task", () => {
  assert.match(ui, /campaignRunApproval\?\.run\?\.status === "PAUSED"/);
  assert.match(ui, /Research stopped safely — no automatic retry/);
  assert.match(ui, /Plan a new campaign \(free\)/);
  assert.match(ui, /createManualTestCampaign\(p\.id\)/);
  assert.match(ui, /The previous request will not be repeated/);
});
