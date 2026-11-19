import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ui = readFileSync(new URL("../web/main.tsx", import.meta.url), "utf8");

test("legacy discovery-only budget outcome cannot override a full-run result", () => {
  const banner = ui.indexOf('aria-label="Paid campaign run outcome"');
  assert.ok(banner > 0);
  const before = ui.slice(banner - 630, banner);
  assert.match(before, /campaignRunApproval\?\.run/);
  assert.match(before, /!campaignRunApproval\.fullRun/);
  assert.match(ui, /Approved research limit reached successfully/);
  assert.match(ui, /Partial qualified-email results/);
});

test("zero-verified-contact full runs never show an irrelevant batch-saving warning", () => {
  const warning = ui.indexOf("Batch contact saving is not");
  assert.ok(warning > 0);
  assert.match(ui.slice(warning - 210, warning),
    /qualifiedManifest\.selectedCount > 0[\s\S]*!qualifiedManifest\.batchEnabled/);
  assert.match(ui, /No verified person-email contacts found/);
  assert.match(ui, /No email addresses were guessed/);
});
