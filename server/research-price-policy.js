// A verified, server-owned price ceiling is mandatory before any billable
// research call. The registry is intentionally empty until #44 is complete:
// request quotas and saved USD preferences are not monetary enforcement.
const approvedResearchPrices = Object.freeze({
  // Explicit pilot approval: Claude's basic server-side web-search tool
  // enforces max_uses=3; Sonnet 4.6 has a 1M-token context and a bounded
  // 3,200-token response. Rates: USD 3 / 1M input, USD 15 / 1M output,
  // USD 10 / 1,000 web searches (Anthropic official pricing, 2026-11-16).
  // No caching, batch, or geography premium is requested by this adapter.
  // Reserve USD 4.00 per attempt, conservatively above USD 3.08 modeled
  // worst-case. Actual API usage is NOT sufficiently certified to refund.
  "anthropic:claude-sonnet-4-6": Object.freeze({
    provider: "anthropic",
    enforcementReady: true,
    priceVersion: "anthropic-sonnet-4-6-web-search-2026-11-16",
    expiresAt: new Date("2026-12-01T00:00:00Z"),
    billingContractVersion: "anthropic-web-search-20250305-v1",
    worstCaseCents: 400,
    pricing: Object.freeze({
      billingUnit: "search_requests",
      inputCentsPerMillion: 300,
      outputCentsPerMillion: 1500,
      searchCentsPerThousand: 1000,
    }),
    usageLimits: Object.freeze({
      maxInputTokens: 1_000_000,
      maxOutputTokens: 3200,
      maxSearchRequests: 3,
    }),
  }),
  "openai:gpt-4.1-mini": Object.freeze({
    provider: "openai",
    enforcementReady: true,
    priceVersion: "openai-gpt-4.1-mini-web-search-2026-11-16",
    expiresAt: new Date("2026-12-01T00:00:00Z"),
    billingContractVersion: "openai-web-search-responses-v1",
    worstCaseCents: 150,
    pricing: Object.freeze({
      billingUnit: "search_requests",
      inputCentsPerMillion: 40,
      outputCentsPerMillion: 160,
      searchCentsPerThousand: 1000,
    }),
    usageLimits: Object.freeze({
      // One million context tokens plus 8k fixed web-search content
      // tokens per search (up to three) for gpt-4.1-mini.
      maxInputTokens: 1_024_000,
      maxOutputTokens: 3200,
      maxSearchRequests: 3,
    }),
  }),
  "gemini:gemini-2.5-flash": Object.freeze({
    provider: "gemini",
    enforcementReady: true,
    priceVersion: "gemini-2.5-flash-grounded-prompt-2026-11-16",
    expiresAt: new Date("2026-12-01T00:00:00Z"),
    billingContractVersion: "gemini-2.5-google-search-grounded-prompt-v1",
    worstCaseCents: 200,
    pricing: Object.freeze({
      billingUnit: "grounded_prompts",
      inputCentsPerMillion: 30,
      outputCentsPerMillion: 250,
      searchCentsPerThousand: 3500,
    }),
    usageLimits: Object.freeze({
      maxInputTokens: 1_000_000,
      maxOutputTokens: 3200,
      maxGroundedPrompts: 1,
    }),
  }),
});

// Compute a strictly conservative ceiling for the only currently modeled
// billing shape. Other provider tool billing units require their own reviewed
// capability contracts; we never reinterpret them as search requests.
export function calculateBoundedWorstCaseCents(pricing, limits) {
  if (!["search_requests", "grounded_prompts"].includes(pricing?.billingUnit) ||
      !limits) return null;
  const rates = [pricing.inputCentsPerMillion, pricing.outputCentsPerMillion,
    pricing.searchCentsPerThousand];
  const max = [limits.maxInputTokens, limits.maxOutputTokens,
    pricing.billingUnit === "grounded_prompts" ? limits.maxGroundedPrompts
      : limits.maxSearchRequests];
  if (rates.some(x => !Number.isSafeInteger(x) || x <= 0) ||
      max.some(x => !Number.isSafeInteger(x) || x <= 0)) return null;
  const costUnits = BigInt(max[0]) * BigInt(rates[0]) +
    BigInt(max[1]) * BigInt(rates[1]) +
    BigInt(max[2]) * BigInt(rates[2]) * 1000n;
  const rounded = (costUnits + 999999n) / 1000000n;
  if (rounded < 1n || rounded > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(rounded);
}

// Exact dual-provider billing shape. This validates a *candidate* server-owned
// tariff; it does not register it or authorize any billable execution. Existing
// single-provider policy behavior is unchanged.
export function calculateResearchPricePolicyCeilingCents(policy) {
  if (policy?.billingContractVersion === "tavily-basic-gemini3-text-v1") {
    if (policy.provider !== "gemini" ||
        policy.model !== "gemini-3-flash-preview" ||
        policy.retrievalProvider !== "tavily" ||
        policy.retrieval?.maxRequests !== 1 ||
        policy.textModel?.maxOutputTokens !== 2048 ||
        policy.textModel?.maxInputTokens > 16_384) return null;
    return calculateCombinedRetrievalAndTextCeilingCents({
      retrieval: policy.retrieval, textModel: policy.textModel,
    })?.worstCaseCents ?? null;
  }
  return calculateBoundedWorstCaseCents(policy?.pricing, policy?.usageLimits);
}

export class ResearchPricingUnavailable extends Error {
  constructor() {
    super("Paid AI research pricing and monetary enforcement are not available");
    this.name = "ResearchPricingUnavailable";
  }
}

// Fail closed for every provider/model/tool combination not explicitly
// approved under a versioned, bounded price envelope. Never accept browser
// pricing, unbounded provider search calls or a wildcard model allowance.
export function requireResearchPriceEnvelope({ provider, model }) {
  if (typeof provider !== "string" || typeof model !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{1,79}$/.test(model)) {
    throw new ResearchPricingUnavailable();
  }
  const policy = approvedResearchPrices[provider + ":" + model];
  if (!policy || policy.enforcementReady !== true ||
      !Number.isSafeInteger(policy.worstCaseCents) ||
      policy.worstCaseCents <= 0 ||
      // A positive client-independent amount alone proves nothing. Require
      // the reviewed tariff's conservative worst-case calculation.
      calculateResearchPricePolicyCeilingCents(policy) === null ||
      policy.worstCaseCents < calculateResearchPricePolicyCeilingCents(policy) ||
      typeof policy.priceVersion !== "string" || !policy.priceVersion ||
      !(policy.expiresAt instanceof Date) ||
      policy.expiresAt.getTime() <= Date.now()) {
    throw new ResearchPricingUnavailable();
  }
  return policy;
}

// Read-only model/budget readiness. Exactly the same exact-model pricing
// registry governs this projection and the paid worker preflight. No key,
// account credit, or browser-selected model may override a missing tariff.
export function researchPriceReadiness({ setting, enabled, remainingCents }) {
  const model = setting?.model ?? null;
  const provider = setting?.provider ?? null;
  if (!setting || !provider || !model) {
    return { provider, model, pricingStatus: "AI_SETTINGS_REQUIRED",
      worstCaseCents: null, enforcedForPaidSearch: false };
  }
  let price;
  try {
    price = requireResearchPriceEnvelope({ provider, model });
  } catch (error) {
    if (!(error instanceof ResearchPricingUnavailable)) throw error;
    return { provider, model, pricingStatus: "MODEL_PRICING_UNAVAILABLE",
      worstCaseCents: null, enforcedForPaidSearch: false };
  }
  const ready = Number.isSafeInteger(remainingCents) &&
    remainingCents >= price.worstCaseCents;
  return { provider, model,
    pricingStatus: !enabled ? "RESEARCH_DISABLED"
      : !ready ? "INSUFFICIENT_APP_BUDGET" : "READY",
    worstCaseCents: price.worstCaseCents,
    enforcedForPaidSearch: !!enabled && ready };
}

// Calculate only when a reviewed exact-model tariff and all billable units
// are present in the server-side provider response. This routine must never
// receive user-submitted usage or a client-supplied price contract.
// Null means uncertain charges: retain the full reserved worst-case amount.
export function calculateVerifiedSpendCents(policy, usage) {
  if (!policy || policy.enforcementReady !== true ||
      !usage || typeof usage !== "object") return null;
  // The adapter must explicitly certify that every chargeable usage unit
  // for this exact model/tool tariff was captured from provider metadata.
  // Only the trusted adapter may certify the exact provider billing units.
  // Missing or ambiguous provider usage always settles at the reserved ceiling.
  if (usage.billingEvidence?.source !== "provider" ||
      usage.billingEvidence?.complete !== true ||
      usage.billingEvidence?.provider !== policy.provider ||
      usage.billingEvidence?.contractVersion !== policy.billingContractVersion ||
      usage.billingEvidence?.billingUnit !== policy.pricing?.billingUnit ||
      !["openai", "anthropic", "gemini"].includes(policy.provider) ||
      typeof policy.billingContractVersion !== "string" ||
      policy.billingContractVersion.length < 1) return null;
  const pricing = policy.pricing;
  const limits = policy.usageLimits;
  // Tool billing differs across providers. Unsupported tariff shapes fail
  // closed; in particular Gemini 2.5 uses grounded prompts, not query counts.
  if (!pricing || !["search_requests", "grounded_prompts"].includes(pricing.billingUnit) ||
      !limits || !Number.isSafeInteger(policy.worstCaseCents) ||
      policy.worstCaseCents < 1) return null;
  const isGroundedPrompt = pricing.billingUnit === "grounded_prompts";
  const units = isGroundedPrompt ? usage.groundedPrompts : usage.searchRequests;
  const maxUnits = isGroundedPrompt ? limits.maxGroundedPrompts : limits.maxSearchRequests;
  const fields = [
    [usage.inputTokens, limits.maxInputTokens],
    [usage.outputTokens, limits.maxOutputTokens],
    [units, maxUnits],
  ];
  if (fields.some(([count, bound]) =>
    !Number.isSafeInteger(count) || count < 0 ||
    !Number.isSafeInteger(bound) || bound < 0 || count > bound) ||
    units < 1) return null;
  const rates = [
    pricing.inputCentsPerMillion,
    pricing.outputCentsPerMillion,
    pricing.searchCentsPerThousand,
  ];
  // Search is a paid tool in this tariff shape. Zero or missing rates
  // could silently refund real provider charges, so reject the policy.
  if (rates.some(rate => !Number.isSafeInteger(rate) || rate <= 0)) return null;
  const numerator =
    BigInt(usage.inputTokens) * BigInt(rates[0]) +
    BigInt(usage.outputTokens) * BigInt(rates[1]) +
    BigInt(units) * BigInt(rates[2]) * 1000n;
  const cents = (numerator + 999999n) / 1000000n;
  if (cents > BigInt(policy.worstCaseCents) ||
      cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(cents);
}


// Pure math for an eventual independently billed retrieval + Gemini text-only
// task. It is NOT an authorization or an approved tariff. Only a future exact
// server-owned, reviewed policy and upstream-enforced request/token caps can
// make a quote eligible for reserveOwnerSpend. Never call this on user prices.
export function calculateCombinedRetrievalAndTextCeilingCents({
  retrieval, textModel,
} = {}) {
  const valid = (v, max) => Number.isSafeInteger(v) && v > 0 && v <= max;
  if (!retrieval || !textModel ||
      !valid(retrieval.maxRequests, 100) ||
      !valid(retrieval.centsPerThousandRequests, 1_000_000) ||
      !valid(textModel.maxInputTokens, 1_000_000) ||
      !valid(textModel.maxOutputTokens, 100_000) ||
      !valid(textModel.inputCentsPerMillion, 1_000_000) ||
      !valid(textModel.outputCentsPerMillion, 1_000_000)) return null;

  // Round each independently billable component upward before adding it.
  // Individual input/output components may be rounded on the invoice;
  // rounding only their sum can under-reserve one cent.
  const ceilDiv = (amount, divisor) => (amount + divisor - 1n) / divisor;
  const retrievalCents = ceilDiv(
    BigInt(retrieval.maxRequests) *
      BigInt(retrieval.centsPerThousandRequests), 1000n);
  const inputCents = ceilDiv(
    BigInt(textModel.maxInputTokens) *
      BigInt(textModel.inputCentsPerMillion), 1000000n);
  const outputCents = ceilDiv(
    BigInt(textModel.maxOutputTokens) *
      BigInt(textModel.outputCentsPerMillion), 1000000n);
  const modelCents = inputCents + outputCents;
  const total = retrievalCents + modelCents;
  if (total < 1n || total > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Object.freeze({
    retrievalCents: Number(retrievalCents),
    textModelCents: Number(modelCents),
    worstCaseCents: Number(total),
    // This structural quote must never be treated as a price-policy approval.
    enforcementReady: false,
  });
}


// Settlement contract for a future versioned Tavily Basic + Gemini 3 text-only
// price policy. It cannot authorize dispatch. The existing campaign worker
// must call this ONLY with a server-owned reviewed policy and usage attested
// by BOTH trusted provider adapters. Null retains the ENTIRE reservation.
// Current dual-provider adapter returns diagnostic usage only; consequently
// current responses cannot pass this gate and must settle conservatively.
export function calculateVerifiedCombinedSpendCents(policy, usage) {
  if (!policy || policy.enforcementReady !== true ||
      policy.provider !== "gemini" || policy.model !== "gemini-3-flash-preview" ||
      policy.retrievalProvider !== "tavily" ||
      policy.billingContractVersion !== "tavily-basic-gemini3-text-v1" ||
      !Number.isSafeInteger(policy.worstCaseCents) ||
      policy.worstCaseCents <= 0 || !usage ||
      usage.billingEvidence?.source !== "trusted_provider_adapters" ||
      usage.billingEvidence?.contractVersion !== policy.billingContractVersion ||
      usage.billingEvidence?.complete !== true ||
      usage.billingEvidence?.retrievalProvider !== "tavily" ||
      usage.billingEvidence?.textProvider !== "gemini" ||
      usage.billingEvidence?.model !== policy.model) return null;

  const retrieval = policy.retrieval;
  const textModel = policy.textModel;
  const modeled = calculateCombinedRetrievalAndTextCeilingCents({
    retrieval, textModel,
  });
  if (!modeled || policy.worstCaseCents < modeled.worstCaseCents) return null;

  const bounds = [
    [usage.retrievalCredits, retrieval.maxRequests],
    [usage.inputTokens, textModel.maxInputTokens],
    // Gemini thinking tokens are part of paid OUTPUT, not free metadata.
    [usage.outputTokens, textModel.maxOutputTokens],
    [usage.thinkingTokens, textModel.maxOutputTokens],
  ];
  if (bounds.some(([value, max]) => !Number.isSafeInteger(value) ||
      value < 0 || value > max) ||
      usage.retrievalCredits !== 1 ||
      usage.inputTokens === 0 ||
      usage.outputTokens + usage.thinkingTokens > textModel.maxOutputTokens) {
    return null;
  }

  const ceil = (n, d) => (n + d - 1n) / d;
  const retrievalCents = ceil(
    BigInt(usage.retrievalCredits) *
      BigInt(retrieval.centsPerThousandRequests), 1000n);
  const inputCents = ceil(
    BigInt(usage.inputTokens) *
      BigInt(textModel.inputCentsPerMillion), 1000000n);
  const outputCents = ceil(
    BigInt(usage.outputTokens + usage.thinkingTokens) *
      BigInt(textModel.outputCentsPerMillion), 1000000n);
  const total = retrievalCents + inputCents + outputCents;
  return total <= BigInt(policy.worstCaseCents) &&
    total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : null;
}
