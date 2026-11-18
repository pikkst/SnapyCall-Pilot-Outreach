import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ui = readFileSync(new URL("../web/main.tsx", import.meta.url), "utf8");

test("Gemini 3 settings describes approved Tavily text-only pricing, not obsolete disabled Search", () => {
  assert.match(ui, /Gemini 3 Flash uses one bounded Tavily Basic search/);
  assert.match(ui, /text-only Gemini extraction with no native/);
  assert.match(ui, /The server reserves up to \$0\.03 per task/);
  assert.match(ui, /Gemini 3 Flash with Tavily Basic \(up to \$0\.03\)/);
  assert.doesNotMatch(ui, /paid discovery is currently disabled for this exact model/);
  assert.doesNotMatch(ui, /Gemini 3 Flash\s+has different search-query billing and is not yet approved/);
});

test("Gemini 3 UI retains explicit paid-run consent and conservative no-send warnings", () => {
  assert.match(ui, /Start one full contact research pipeline/);
  assert.match(ui, /Maximum paid research requests/);
  assert.match(ui, /I approve this maximum reserve/);
  assert.match(ui, /Approve full pipeline/);
  assert.match(ui, /Saving the model never launches research or sends email/);
  assert.match(ui, /stops new paid calls without retry/);
});
