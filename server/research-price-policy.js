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
      calculateBoundedWorstCaseCents(policy.pricing, policy.usageLimits) === null ||
      policy.worstCaseCents <
        calculateBoundedWorstCaseCents(policy.pricing, policy.usageLimits) ||
      typeof policy.priceVersion !== "string" || !policy.priceVersion ||
      !(policy.expiresAt instanceof Date) ||
      policy.expiresAt.getTime() <= Date.now()) {
    throw new ResearchPricingUnavailable();
  }
  return policy;
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
  // Current adapters do not provide this certification, so they must always
  // settle conservatively at the full reserved amount.
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
  if (!pricing || pricing.billingUnit !== "search_requests" ||
      !limits || !Number.isSafeInteger(policy.worstCaseCents) ||
      policy.worstCaseCents < 1) return null;
  const fields = [
    [usage.inputTokens, limits.maxInputTokens],
    [usage.outputTokens, limits.maxOutputTokens],
    [usage.searchRequests, limits.maxSearchRequests],
  ];
  if (fields.some(([count, bound]) =>
    !Number.isSafeInteger(count) || count < 0 ||
    !Number.isSafeInteger(bound) || bound < 0 || count > bound) ||
    usage.searchRequests < 1) return null;
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
    BigInt(usage.searchRequests) * BigInt(rates[2]) * 1000n;
  const cents = (numerator + 999999n) / 1000000n;
  if (cents > BigInt(policy.worstCaseCents) ||
      cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(cents);
}
