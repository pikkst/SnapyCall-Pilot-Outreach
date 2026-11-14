// A verified, server-owned price ceiling is mandatory before any billable
// research call. The registry is intentionally empty until #44 is complete:
// request quotas and saved USD preferences are not monetary enforcement.
const approvedResearchPrices = Object.freeze({});

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
