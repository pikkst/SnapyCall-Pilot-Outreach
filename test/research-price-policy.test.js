import test from "node:test";
import assert from "node:assert/strict";
import { requireResearchPriceEnvelope, ResearchPricingUnavailable,
  calculateBoundedWorstCaseCents } from "../server/research-price-policy.js";

test("only Claude Sonnet 4.6 has a dated server-authorized bounded pricing envelope", () => {
  const policy = requireResearchPriceEnvelope({
    provider: "anthropic", model: "claude-sonnet-4-6",
  });
  assert.equal(policy.provider, "anthropic");
  assert.equal(policy.worstCaseCents, 400);
  assert.equal(policy.pricing.billingUnit, "search_requests");
  assert.equal(policy.usageLimits.maxSearchRequests, 3);
  assert.equal(policy.usageLimits.maxOutputTokens, 3200);
  assert.equal(policy.usageLimits.maxInputTokens, 1_000_000);
  const modeledMax = calculateBoundedWorstCaseCents(policy.pricing, policy.usageLimits);
  assert.equal(modeledMax, 308);
  assert.ok(policy.worstCaseCents >= modeledMax);
  assert.ok(policy.expiresAt > new Date("2026-11-16T00:00:00Z"));
});

test("all other models remain blocked despite the pilot activation", () => {
  for (const config of [
    { provider: "openai", model: "gpt-4.1" },
    { provider: "gemini", model: "gemini-2.5-flash" },
    { provider: "anthropic", model: "claude-sonnet-4-5" },
    { provider: "anthropic", model: "arbitrary-custom-model" },
    { provider: "unknown", model: "gpt-4.1" },
  ]) assert.throws(() => requireResearchPriceEnvelope(config), ResearchPricingUnavailable);
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
  provider: "openai",
  billingContractVersion: "synthetic-search-v1",
  worstCaseCents: 100,
  // Synthetic test rates; these are NOT approved real provider prices.
  pricing: { billingUnit: "search_requests",
    inputCentsPerMillion: 100, outputCentsPerMillion: 500,
    searchCentsPerThousand: 1000 },
  usageLimits: { maxInputTokens: 10000, maxOutputTokens: 3200,
    maxSearchRequests: 3 },
});

const completeUsage = Object.freeze({
  inputTokens: 1000, outputTokens: 500, searchRequests: 2,
  // Synthetic certification only. Real provider adapters currently omit it.
  billingEvidence: { source: "provider", complete: true, provider: "openai",
    contractVersion: "synthetic-search-v1", billingUnit: "search_requests" },
});

test("synthetic complete billing evidence rounds USD cents conservatively", () => {
  assert.equal(calculateVerifiedSpendCents(reviewedFixture, completeUsage), 3);
  assert.equal(calculateVerifiedSpendCents(reviewedFixture, {
    ...completeUsage, inputTokens: 0, outputTokens: 0, searchRequests: 0,
  }), null, "A claimed zero searches cannot refund a billable web-search call");
});

test("provider totals alone never authorize refund without a complete billing contract", () => {
  const { billingEvidence: _billingEvidence, ...adapterUsage } = completeUsage;
  assert.equal(calculateVerifiedSpendCents(reviewedFixture, adapterUsage), null);
  for (const billingEvidence of [
    { ...completeUsage.billingEvidence, complete: false },
    { ...completeUsage.billingEvidence, provider: "anthropic" },
    { ...completeUsage.billingEvidence, billingUnit: "grounded_prompts" },
    { ...completeUsage.billingEvidence, contractVersion: "stale-contract" },
    { ...completeUsage.billingEvidence, source: "browser" },
  ]) assert.equal(calculateVerifiedSpendCents(reviewedFixture,
    { ...completeUsage, billingEvidence }), null);
});

test("missing or unbounded usage preserves the entire monetary reservation", () => {
  const complete = { ...completeUsage, searchRequests: 1 };
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
  const usage = { ...completeUsage, inputTokens: 20, outputTokens: 20, searchRequests: 1 };
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
  assert.equal(calculateVerifiedSpendCents({ ...reviewedFixture,
    pricing: { ...reviewedFixture.pricing, searchCentsPerThousand: 0 },
  }, usage), null, "Missing web-tool cost cannot be treated as free");
});

test("worst-case quote covers all bounded input, output and search tool units", () => {
  assert.equal(calculateBoundedWorstCaseCents(reviewedFixture.pricing,
    reviewedFixture.usageLimits), 6);
  const bad = [
    { ...reviewedFixture.pricing, billingUnit: "grounded_prompts" },
    { ...reviewedFixture.pricing, searchCentsPerThousand: 0 },
    { ...reviewedFixture.pricing, inputCentsPerMillion: null },
  ];
  for (const rates of bad) {
    assert.equal(calculateBoundedWorstCaseCents(rates,
      reviewedFixture.usageLimits), null);
  }
  for (const limits of [
    { ...reviewedFixture.usageLimits, maxInputTokens: null },
    { ...reviewedFixture.usageLimits, maxSearchRequests: 0 },
    { ...reviewedFixture.usageLimits, maxOutputTokens: -1 },
  ]) assert.equal(calculateBoundedWorstCaseCents(reviewedFixture.pricing,
    limits), null);
});
