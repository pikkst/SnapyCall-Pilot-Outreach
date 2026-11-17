// Single-request Gemini 3 diagnostic accounting. Pricing is for an
// after-the-fact estimate, NOT a hard upstream bill limit. Never log raw
// prompts, model text, URLs, API keys, personal names or contact addresses.
export const GEMINI3_TEST_MODEL = "gemini-3-flash-preview";
export const GEMINI3_TEST_RESERVE_CENTS = 500;
export const GEMINI3_TEST_ACTION = "ai.gemini3-one-shot.dispatched";
export const GEMINI3_TEST_CONFIRMATION = "RUN_ONE_GEMINI3_PAID_TEST";

function units(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function summarizeGemini3TestResponse(response) {
  const raw = response?.usageMetadata;
  const candidate = Array.isArray(response?.candidates) ? response.candidates[0] : null;
  const metadata = candidate?.groundingMetadata;
  const inputTokens = units(raw?.promptTokenCount);
  const outputTokens = units(raw?.candidatesTokenCount);
  const thinkingTokens = units(raw?.thoughtsTokenCount ?? 0);
  const searchQueries = Array.isArray(metadata?.webSearchQueries) &&
    metadata.webSearchQueries.length <= 100
    ? metadata.webSearchQueries.length : null;
  const groundingChunks = Array.isArray(metadata?.groundingChunks) &&
    metadata.groundingChunks.length <= 200
    ? metadata.groundingChunks.length : null;

  // Google Gemini 3 Flash Preview Standard (Nov 2026): $0.50 / 1M
  // input, $3.00 / 1M output including thinking, $14 / 1,000
  // billable Google Search queries. The user's free allowance is
  // unknown, as are final charges/discounts/taxes.
  const estimateUsd = inputTokens !== null && outputTokens !== null &&
    thinkingTokens !== null && searchQueries !== null
    ? Math.round((inputTokens * 0.50 / 1e6 +
        (outputTokens + thinkingTokens) * 3.00 / 1e6 +
        searchQueries * 14 / 1000) * 1e6) / 1e6
    : null;
  return Object.freeze({
    model: GEMINI3_TEST_MODEL,
    finished: candidate?.finishReason === "STOP",
    finishReason: typeof candidate?.finishReason === "string"
      ? candidate.finishReason.slice(0, 30) : null,
    inputTokens, outputTokens, thinkingTokens,
    searchQueries, groundingChunks, estimateUsd,
    currency: "USD", providerInvoiceConfirmed: false,
    estimateIncludesPotentialFreeSearchAllowance: false,
  });
}
