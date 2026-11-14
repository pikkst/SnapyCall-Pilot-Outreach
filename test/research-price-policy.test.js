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

import { calculateVerifiedSpendCents } from "../server/research-price-policy.js";

const reviewedFixture = Object.freeze({
  enforcementReady: true,
  worstCaseCents: 100,
  // Synthetic test rates; these are NOT approved real provider prices.
  pricing: { billingUnit: "search_requests",
    inputCentsPerMillion: 100, outputCentsPerMillion: 500,
    searchCentsPerThousand: 1000 },
  usageLimits: { maxInputTokens: 10000, maxOutputTokens: 3200,
    maxSearchRequests: 3 },
});

test("synthetic server tariff reconciles authenticated usage with upward cent rounding", () => {
  assert.equal(calculateVerifiedSpendCents(reviewedFixture, {
    inputTokens: 1000, outputTokens: 500, searchRequests: 2,
  }), 3);
  assert.equal(calculateVerifiedSpendCents(reviewedFixture, {
    inputTokens: 0, outputTokens: 0, searchRequests: 0,
  }), 0);
});

test("missing or unbounded usage preserves the entire monetary reservation", () => {
  const complete = { inputTokens: 1000, outputTokens: 500, searchRequests: 1 };
  for (const usage of [
    null, {}, { ...complete, searchRequests: null },
    { ...complete, inputTokens: -1 },
    { ...complete, inputTokens: "1000" },
    { ...complete, outputTokens: 3201 },
    { ...complete, searchRequests: 4 },
    { ...complete, inputTokens: Number.MAX_SAFE_INTEGER },
  ]) assert.equal(calculateVerifiedSpendCents(reviewedFixture, usage), null);
  assert.equal(calculateVerifiedSpendCents({
    ...reviewedFixture, worstCaseCents: 1,
  }, complete), null, "Cost exceeding the reserved ceiling must not be refunded");
});

test("unapproved or differently metered provider pricing cannot produce a refund", () => {
  const usage = { inputTokens: 20, outputTokens: 20, searchRequests: 1 };
  assert.equal(calculateVerifiedSpendCents({ ...reviewedFixture,
    enforcementReady: false }, usage), null);
  assert.equal(calculateVerifiedSpendCents({ ...reviewedFixture,
    pricing: { ...reviewedFixture.pricing, billingUnit: "grounded_prompts" },
  }, usage), null);
  assert.equal(calculateVerifiedSpendCents({ ...reviewedFixture,
    pricing: { ...reviewedFixture.pricing, inputCentsPerMillion: -1 },
  }, usage), null);
  assert.equal(calculateVerifiedSpendCents({ ...reviewedFixture,
    usageLimits: { ...reviewedFixture.usageLimits, maxSearchRequests: null },
  }, usage), null);
});
