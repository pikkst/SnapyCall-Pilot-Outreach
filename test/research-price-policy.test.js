import test from "node:test";
import assert from "node:assert/strict";
import { requireResearchPriceEnvelope, ResearchPricingUnavailable,
  researchPriceReadiness, calculateBoundedWorstCaseCents } from "../server/research-price-policy.js";

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

test("provider-specific paid search policies price Gemini grounded prompts and OpenAI tool calls", () => {
  const openai = requireResearchPriceEnvelope({ provider: "openai", model: "gpt-4.1-mini" });
  assert.equal(openai.worstCaseCents, 150);
  assert.equal(openai.pricing.billingUnit, "search_requests");
  assert.equal(openai.usageLimits.maxSearchRequests, 3);
  assert.ok(calculateBoundedWorstCaseCents(openai.pricing, openai.usageLimits) <= 150);

  const gemini = requireResearchPriceEnvelope({ provider: "gemini", model: "gemini-2.5-flash" });
  assert.equal(gemini.worstCaseCents, 200);
  assert.equal(gemini.pricing.billingUnit, "grounded_prompts");
  assert.equal(gemini.usageLimits.maxGroundedPrompts, 1);
  assert.ok(calculateBoundedWorstCaseCents(gemini.pricing, gemini.usageLimits) <= 200);
  assert.equal(calculateVerifiedSpendCents(gemini, {
    inputTokens: 1, outputTokens: 1, searchRequests: 1,
  }), null, "Gemini must retain the full reservation, never infer prompt fees from query counts");
});

test("all other models remain blocked despite the pilot activation", () => {
  for (const config of [
    { provider: "openai", model: "gpt-4.1" },
    { provider: "gemini", model: "gemini-3-flash-preview" },
    { provider: "gemini", model: "gemini-3.1-pro-preview" },
    { provider: "anthropic", model: "claude-sonnet-4-5" },
    { provider: "anthropic", model: "arbitrary-custom-model" },
    { provider: "unknown", model: "gpt-4.1" },
  ]) assert.throws(() => requireResearchPriceEnvelope(config), ResearchPricingUnavailable);
});

test("caller-provided pricing cannot override an approved exact-model policy", () => {
  const policy = requireResearchPriceEnvelope({
    provider: "gemini", model: "gemini-2.5-flash",
    priceVersion: "user-supplied", worstCaseCents: 1, enforcementReady: false,
    expiresAt: new Date("2099-01-01"),
  });
  assert.equal(policy.worstCaseCents, 200);
  assert.equal(policy.priceVersion, "gemini-2.5-flash-grounded-prompt-2026-11-16");
});

test("caller approvals and forged model identifiers cannot authorize unavailable models", () => {
  for (const config of [
    { provider: "openai", model: "gpt-4.1", worstCaseCents: 1, enforcementReady: true },
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

test("certified Gemini grounded-prompt usage settles per prompt, not per query", () => {
  const policy = requireResearchPriceEnvelope({ provider: "gemini", model: "gemini-2.5-flash" });
  const usage = {
    inputTokens: 1000, outputTokens: 300, groundedPrompts: 1,
    searchRequests: 19,
    billingEvidence: {
      source: "provider", complete: true, provider: "gemini",
      contractVersion: policy.billingContractVersion, billingUnit: "grounded_prompts",
    },
  };
  assert.equal(calculateVerifiedSpendCents(policy, usage), 4);
  assert.equal(calculateVerifiedSpendCents(policy, { ...usage, groundedPrompts: 2 }), null);
  assert.equal(calculateVerifiedSpendCents(policy, { ...usage, groundedPrompts: undefined }), null);
  assert.equal(calculateVerifiedSpendCents(policy, {
    ...usage, billingEvidence: { ...usage.billingEvidence, complete: false },
  }), null);
});

test("Gemini 3 pricing remains blocked before API dispatch regardless of available money", () => {
  const config = { provider: "gemini", model: "gemini-3-flash-preview" };
  for (const remainingCents of [100, 100_000, Number.MAX_SAFE_INTEGER]) {
    const state = researchPriceReadiness({
      setting: config, enabled: true, remainingCents,
    });
    assert.deepEqual(state, {
      provider: "gemini", model: "gemini-3-flash-preview",
      pricingStatus: "MODEL_PRICING_UNAVAILABLE",
      worstCaseCents: null, enforcedForPaidSearch: false,
    });
  }
  const historical = researchPriceReadiness({
    setting: { provider: "gemini", model: "gemini-2.5-flash" },
    enabled: true, remainingCents: 500,
  });
  assert.equal(historical.enforcedForPaidSearch, true);
  assert.equal(historical.worstCaseCents, 200);
});

test("server pricing readiness never authorizes absent keys, disabled research or insufficient budget", () => {
  assert.equal(researchPriceReadiness({
    setting: null, enabled: true, remainingCents: 1000,
  }).pricingStatus, "AI_SETTINGS_REQUIRED");
  assert.equal(researchPriceReadiness({
    setting: { provider: "gemini", model: "gemini-2.5-flash" },
    enabled: false, remainingCents: 1000,
  }).pricingStatus, "RESEARCH_DISABLED");
  assert.equal(researchPriceReadiness({
    setting: { provider: "gemini", model: "gemini-2.5-flash" },
    enabled: true, remainingCents: 199,
  }).pricingStatus, "INSUFFICIENT_APP_BUDGET");
  for (const remainingCents of [null, -1, NaN, "500"]) {
    assert.equal(researchPriceReadiness({
      setting: { provider: "gemini", model: "gemini-2.5-flash" },
      enabled: true, remainingCents,
    }).enforcedForPaidSearch, false);
  }
});


const { calculateCombinedRetrievalAndTextCeilingCents } =
  await import("../server/research-price-policy.js");

const syntheticCombinedTariff = {
  // Synthetic test numbers only, not an approved search provider price.
  retrieval: { maxRequests: 2, centsPerThousandRequests: 500 },
  textModel: {
    maxInputTokens: 1000, maxOutputTokens: 2048,
    inputCentsPerMillion: 50, outputCentsPerMillion: 300,
  },
};

test("two independent providers are rounded upward before reserving combined spend", () => {
  assert.deepEqual(
    calculateCombinedRetrievalAndTextCeilingCents(syntheticCombinedTariff),
    { retrievalCents: 1, textModelCents: 2,
      worstCaseCents: 3, enforcementReady: false });
  assert.equal(
    calculateCombinedRetrievalAndTextCeilingCents({
      ...syntheticCombinedTariff,
      retrieval: { ...syntheticCombinedTariff.retrieval, maxRequests: 3 },
    }).worstCaseCents, 4);
});

test("combined quote fails closed on missing, negative, fractional or excessive limits", () => {
  const badRetrieval = [
    { maxRequests: 0, centsPerThousandRequests: 500 },
    { maxRequests: 2.5, centsPerThousandRequests: 500 },
    { maxRequests: 101, centsPerThousandRequests: 500 },
    { maxRequests: 2, centsPerThousandRequests: 0 },
    { maxRequests: 2, centsPerThousandRequests: "500" },
  ];
  for (const retrieval of badRetrieval) {
    assert.equal(calculateCombinedRetrievalAndTextCeilingCents({
      ...syntheticCombinedTariff, retrieval,
    }), null);
  }
  for (const change of [
    { maxInputTokens: null },
    { maxInputTokens: 1_000_001 },
    { maxOutputTokens: 0 },
    { maxOutputTokens: 100_001 },
    { outputCentsPerMillion: -1 },
    { inputCentsPerMillion: NaN },
  ]) assert.equal(calculateCombinedRetrievalAndTextCeilingCents({
    ...syntheticCombinedTariff,
    textModel: { ...syntheticCombinedTariff.textModel, ...change },
  }), null);
  assert.equal(calculateCombinedRetrievalAndTextCeilingCents({}), null);
});

test("a mathematical quote never unlocks Gemini 3 paid discovery", () => {
  const quote = calculateCombinedRetrievalAndTextCeilingCents(syntheticCombinedTariff);
  assert.equal(quote.enforcementReady, false);
  assert.throws(() => requireResearchPriceEnvelope({
    provider: "gemini", model: "gemini-3-flash-preview",
    ...quote,
  }), ResearchPricingUnavailable);
  const state = researchPriceReadiness({
    setting: { provider: "gemini", model: "gemini-3-flash-preview" },
    enabled: true, remainingCents: 100_000,
  });
  assert.equal(state.enforcedForPaidSearch, false);
  assert.equal(state.pricingStatus, "MODEL_PRICING_UNAVAILABLE");
});

test("combined quote rounds both Gemini input and output components upward independently", () => {
  const quote = calculateCombinedRetrievalAndTextCeilingCents({
    retrieval: { maxRequests: 1, centsPerThousandRequests: 1 },
    textModel: {
      maxInputTokens: 1, maxOutputTokens: 1,
      inputCentsPerMillion: 1, outputCentsPerMillion: 1,
    },
  });
  assert.deepEqual(quote, {
    retrievalCents: 1, textModelCents: 2,
    worstCaseCents: 3, enforcementReady: false,
  });
  // The prior one-shot rounding returned one model cent here, which is not
  // conservative when the provider rounds its two charge categories separately.
  const nearBoundary = calculateCombinedRetrievalAndTextCeilingCents({
    retrieval: { maxRequests: 1, centsPerThousandRequests: 1000 },
    textModel: {
      maxInputTokens: 100_000, maxOutputTokens: 100_000,
      inputCentsPerMillion: 10, outputCentsPerMillion: 10,
    },
  });
  assert.deepEqual(nearBoundary, {
    retrievalCents: 1, textModelCents: 2,
    worstCaseCents: 3, enforcementReady: false,
  });
});
