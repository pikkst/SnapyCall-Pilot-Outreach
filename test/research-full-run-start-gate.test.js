import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fullRunReadiness, FULL_RUN_FLAGS }
  from "../server/research-full-run-readiness.js";

const allEnabled = Object.fromEntries(
  Object.keys(FULL_RUN_FLAGS).map(flag => [flag, "true"]));

test("full-run capability requires all seven actual runtime worker gates", () => {
  const ready = fullRunReadiness(allEnabled);
  assert.equal(ready.enabled, true);
  assert.deepEqual(ready.missingStages, []);
  assert.equal(Object.isFrozen(ready), true);
  for (const [flag, stage] of Object.entries(FULL_RUN_FLAGS)) {
    for (const disabled of [undefined, "false", "TRUE"]) {
      const env = { ...allEnabled, [flag]: disabled };
      const result = fullRunReadiness(env);
      assert.equal(result.enabled, false, flag);
      assert.deepEqual(result.missingStages, [stage]);
    }
  }
});

test("full-run readiness reports only stage names, not private configuration", () => {
  const result = fullRunReadiness({
    ...allEnabled, AI_ENCRYPTION_KEY: "must-never-leak",
    AI_EMAIL_TRIAGE_ENABLED: "false",
    AI_PERSON_SOURCE_EXECUTOR_ENABLED: "false",
  });
  assert.deepEqual(result.missingStages, [
    "person_source_executor", "email_triage",
  ]);
  assert.equal(JSON.stringify(result).includes("must-never-leak"), false);
});

const ui = readFileSync(new URL("../web/main.tsx", import.meta.url), "utf8");
const server = readFileSync(new URL("../server/index.js", import.meta.url), "utf8");

test("primary research Start always requests full-run and cannot silently omit it", () => {
  const start = ui.slice(
    ui.indexOf("async function approveCampaignAutonomousRun"),
    ui.indexOf("async function loadQualifiedContactManifest"),
  );
  assert.ok(start.length > 1000);
  assert.match(start, /!campaignRunApproval\.fullRunEnabled/);
  assert.match(start, /fullRun:\s*\{/);
  assert.match(start, /confirmPublicInspection: true/);
  assert.match(start, /confirmNoAutomaticSending: true/);
  assert.match(start, /result\.code !== "FULL_RUN_APPROVED"/);
  assert.match(start, /fullRun: result\.fullRun/);
  assert.doesNotMatch(start, /campaignApproveFullRun/);
});

test("the UI disables paid Research start when any source/triage worker is off", () => {
  const panel = ui.slice(ui.indexOf('aria-label="Approve a one-launch campaign"'),
    ui.indexOf('aria-label="Saved campaign findings"'));
  assert.match(panel, /!campaignRunApproval\.fullRunEnabled/);
  assert.match(panel, /Full pipeline is not enabled on this server/);
  assert.match(panel, /fullRunMissingStages/);
  assert.match(panel, /Approve full pipeline/);
  assert.doesNotMatch(panel, /Approve single run/);
  assert.doesNotMatch(panel, /discovery-only run does not inspect/);
});

test("API, persisted approval and background worker agree on exact same capability", () => {
  assert.match(server, /fullRunEnabled: fullRunReadiness\(env\)\.enabled/);
  assert.match(server, /!fullRunReadiness\(env\)\.enabled/);
  assert.match(server, /const stopFullRunWorker = fullRunReadiness\(env\)\.enabled/);
  assert.match(server, /fullRunMissingStages: fullRunReadiness\(env\)\.missingStages/);
});

test("discovery-only history is not shown as completed email pipeline", () => {
  assert.match(ui, /Discovery finished · emails not verified/);
  assert.match(ui, /No email inspection or source enrichment was authorized/);
  assert.doesNotMatch(ui, /"Research finished"/);
});
