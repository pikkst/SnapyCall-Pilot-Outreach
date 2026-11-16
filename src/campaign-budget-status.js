// Client display only. The authenticated server budget snapshot and the
// database claim transaction remain authoritative for any paid call.
export function describeCampaignBudget(budget, keyConfigured) {
  const cents = budget?.monthlyLimitCents;
  const remaining = budget?.ledger?.availableCents;
  if (!keyConfigured) return {
    code: "AI_KEY_MISSING", message: "Personal AI API key is not configured.",
  };
  if (!Number.isSafeInteger(cents) || cents < 100) return {
    code: "BUDGET_MISSING", message: "Monthly application research budget is not configured.",
  };
  if (!Number.isSafeInteger(remaining) || remaining < 0) return {
    code: "BUDGET_UNAVAILABLE", message: "Application budget data is unavailable. Refresh before starting paid research.",
  };
  const format = value => "$" + (value / 100).toFixed(2);
  if (remaining === 0) return {
    code: "BUDGET_EXHAUSTED",
    message: "Application research budget exhausted: " + format(remaining) +
      " remaining of " + format(cents) + ". This is the conservative SnapyCall ledger, not the Google Gemini invoice.",
  };
  if (budget.reconciliation?.needsReview || budget.ledger?.pendingReservations > 0) return {
    code: "BILLING_REVIEW",
    message: "Application spend reservations require reconciliation before another paid task.",
  };
  if (!budget.enforcedForPaidSearch) return {
    code: "MODEL_OR_BUDGET_BLOCKED",
    message: "Paid research unavailable with the current model or remaining conservative budget (" +
      format(remaining) + " of " + format(cents) + ").",
  };
  return {
    code: "READY",
    message: "Application research budget: " + format(remaining) +
      " remaining of " + format(cents) + " (conservative USD ledger, not the Gemini invoice).",
  };
}
