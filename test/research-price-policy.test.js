import test from "node:test";
import assert from "node:assert/strict";
import { requireResearchPriceEnvelope, ResearchPricingUnavailable } from "../server/research-price-policy.js";

test("research pricing preflight blocks every provider until a verified monetary policy is released", () => {
  const configurations = [
    { provider: "anthropic", model: "claude-sonnet-4-6" },
    { provider: "openai", model: "gpt-4.1" },
    { provider: "gemini", model: "gemini-2.5-flash" },
    { provider: "anthropic", model: "arbitrary-custom-model" },
    { provider: "unknown", model: "gpt-4.1" },
  ];
  for (const config of configurations) {
    assert.throws(() => requireResearchPriceEnvelope(config), ResearchPricingUnavailable);
  }
});

test("caller-provided prices, approvals and forged identifiers cannot authorize billable search", () => {
  for (const config of [
    { provider: "openai", model: "gpt-4.1", worstCaseCents: 1, enforcementReady: true },
    { provider: "gemini", model: "gemini-2.5-flash", priceVersion: "user-supplied", expiresAt: new Date("2099-01-01") },
    { provider: "anthropic", model: "__proto__" },
    { provider: "anthropic", model: "" },
    { provider: "", model: "claude-sonnet-4-6" },
    { provider: "openai", model: "../../../etc/passwd" },
    { provider: null, model: null },
  ]) assert.throws(() => requireResearchPriceEnvelope(config), ResearchPricingUnavailable);
});
