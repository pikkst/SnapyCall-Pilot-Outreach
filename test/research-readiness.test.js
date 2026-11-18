import test from "node:test";
import assert from "node:assert/strict";
import { researchReadiness } from "../src/research-readiness.js";
import { readFileSync } from "node:fs";

const ready = {
  aiStatus: "ready", keyConfigured: true,
  budgetStatus: "ready", monthlyLimitCents: 1000,
  enforcedForPaidSearch: true, limitsStatus: "ready",
};

test("research requires server authorization and all settings loaded", () => {
  const state = researchReadiness(ready);
  assert.equal(state.ready, true);
  assert.deepEqual(state.steps.map(step => step.state), ["ready", "ready", "ready"]);
  for (const [name, change] of Object.entries({
    noKey: { keyConfigured: false },
    noBudget: { monthlyLimitCents: null },
    serverDisabled: { enforcedForPaidSearch: false },
    aiUnavailable: { aiStatus: "error" },
    budgetUnavailable: { budgetStatus: "error" },
    limitsUnavailable: { limitsStatus: "error" },
  })) {
    const actual = researchReadiness({ ...ready, ...change });
    assert.equal(actual.ready, false, name);
    assert.ok(actual.steps.some(step => step.state !== "ready"), name);
  }
});

test("external provider balance never substitutes for application authorization", () => {
  const status = researchReadiness({ ...ready, enforcedForPaidSearch: false });
  assert.equal(status.ready, false);
  assert.equal(status.steps[2].state, "blocked");
  assert.match(status.steps[2].description, /Adding provider credit alone will not enable it/);
});

test("missing key and budget provide independent configuration actions", () => {
  const status = researchReadiness({ ...ready,
    keyConfigured: false, monthlyLimitCents: null,
    enforcedForPaidSearch: false,
  });
  assert.deepEqual(status.steps.map(step => step.state),
    ["action", "action", "pending"]);
  assert.equal(status.steps[0].action, "settings");
  assert.equal(status.steps[1].action, "settings");
});

test("research UI never enables a paid request without server readiness", () => {
  const source = readFileSync(new URL("../web/main.tsx", import.meta.url), "utf8");
  assert.match(source, /readiness\.steps\.map\(step/);
  assert.match(source, /!campaignNoReplayConfirmed \|\| campaignRunApprovalBusy/);
  assert.match(source, /approveCampaignAutonomousRun\(/);
  assert.ok(source.includes("researchReadiness({"));
  assert.match(source,
    /no specific\s+spreadsheet has been selected or synchronized/);
  assert.match(source,
    /await loadPersonalAiSettings\(\);[\s\S]{0,210}await loadResearchBudget\(\);/);
});

test("unpriced Gemini 3 is blocked even with budget and a configured personal key", () => {
  const status = researchReadiness({
    ...ready,
    selectedProvider: "gemini", selectedModel: "gemini-3-flash-preview",
    savedProvider: "gemini", savedModel: "gemini-3-flash-preview",
    pricingStatus: "MODEL_PRICING_UNAVAILABLE",
    enforcedForPaidSearch: false,
  });
  assert.equal(status.ready, false);
  assert.equal(status.steps[2].state, "blocked");
  assert.match(status.steps[2].description, /cannot enforce a maximum search cost before each request/);
  assert.match(status.steps[2].description, /Your API key and monthly budget are already configured/);
  assert.match(status.steps[2].description, /one-time Gemini 3 diagnostic does not enable a campaign/);
});

test("editing model ID cannot borrow previously approved model's research readiness", () => {
  const status = researchReadiness({
    ...ready,
    selectedProvider: "gemini", selectedModel: "gemini-3-flash-preview",
    savedProvider: "gemini", savedModel: "gemini-2.5-flash",
    pricingStatus: "READY", enforcedForPaidSearch: true,
  });
  assert.equal(status.ready, false);
  assert.equal(status.steps[2].state, "blocked");
  assert.match(status.steps[2].description, /Save this model selection/);
});


test("unapproved non-Gemini models retain generic billing guidance", () => {
  const status = researchReadiness({
    ...ready,
    selectedProvider: "openai", selectedModel: "unsupported-model",
    savedProvider: "openai", savedModel: "unsupported-model",
    pricingStatus: "MODEL_PRICING_UNAVAILABLE",
    enforcedForPaidSearch: false,
  });
  assert.equal(status.ready, false);
  assert.equal(status.steps[2].state, "blocked");
  assert.match(status.steps[2].description, /no approved app-enforced search billing ceiling/);
  assert.doesNotMatch(status.steps[2].description, /Gemini 3/);
});
