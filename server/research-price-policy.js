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
