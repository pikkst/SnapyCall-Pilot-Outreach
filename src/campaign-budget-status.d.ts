export type CampaignBudgetState = {
  code: "AI_KEY_MISSING" | "BUDGET_MISSING" | "BUDGET_UNAVAILABLE" |
    "BUDGET_EXHAUSTED" | "BILLING_REVIEW" |
    "MODEL_OR_BUDGET_BLOCKED" | "READY";
  message: string;
};
export function describeCampaignBudget(budget: {
  monthlyLimitCents: number | null;
  enforcedForPaidSearch: boolean;
  ledger?: { availableCents: number | null; pendingReservations: number };
  reconciliation?: { needsReview: boolean };
}, keyConfigured: boolean): CampaignBudgetState;
