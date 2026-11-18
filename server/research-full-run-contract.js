// Versioned, bounded upfront permission across discovery, source enrichment
// and public-page inspection. It never approves contacts or email sending.
export const FULL_RUN_CONTRACT = "ai98-full-run-v1";
const MAX_TOTAL_CENTS = 50_000;
const MAX_SOURCE_CALLS = 250;
const MAX_PUBLIC_PAGES = 250;
export function validateFullRunScope(fullRun, discovery, price) {
  if (!fullRun || typeof fullRun !== "object" || Array.isArray(fullRun) ||
      Object.keys(fullRun).some(k => ![
        "maxSourceCalls", "maxEmailInspectionPages", "maxTotalWorstCaseCents",
        "confirmPublicInspection", "confirmNoAutomaticRetry",
        "confirmNoAutomaticSending",
      ].includes(k)) ||
      !Number.isInteger(fullRun.maxSourceCalls) ||
      fullRun.maxSourceCalls < 1 || fullRun.maxSourceCalls > MAX_SOURCE_CALLS ||
      !Number.isInteger(fullRun.maxEmailInspectionPages) ||
      fullRun.maxEmailInspectionPages < 1 ||
      fullRun.maxEmailInspectionPages > MAX_PUBLIC_PAGES ||
      !Number.isSafeInteger(fullRun.maxTotalWorstCaseCents) ||
      fullRun.maxTotalWorstCaseCents < 1 ||
      fullRun.maxTotalWorstCaseCents > MAX_TOTAL_CENTS ||
      fullRun.confirmPublicInspection !== true ||
      fullRun.confirmNoAutomaticRetry !== true ||
      fullRun.confirmNoAutomaticSending !== true ||
      !Number.isSafeInteger(price?.worstCaseCents) ||
      price.worstCaseCents < 1) {
    throw new TypeError("Explicit bounded full-run approval required");
  }
  const sourceCents = fullRun.maxSourceCalls * price.worstCaseCents;
  const combined = discovery.maxWorstCaseCents + sourceCents;
  if (!Number.isSafeInteger(combined) ||
      combined !== fullRun.maxTotalWorstCaseCents ||
      combined > MAX_TOTAL_CENTS) {
    throw new TypeError("Full-run maximum must equal sum of stage ceilings");
  }
  return Object.freeze({
    maxSourceCalls: fullRun.maxSourceCalls,
    maxEmailInspectionPages: fullRun.maxEmailInspectionPages,
    maxTotalWorstCaseCents: combined,
    maxSourceWorstCaseCents: sourceCents,
    publicInspectionAuthorized: true,
  });
}
