export type ResearchReadinessStep = {
  key: string;
  state: "unknown" | "ready" | "action" | "pending" | "blocked";
  title: string;
  description: string;
  action: "settings" | "refresh";
};
export function researchReadiness(input: {
  aiStatus: "loading" | "ready" | "error";
  keyConfigured: boolean;
  budgetStatus: "loading" | "ready" | "error";
  monthlyLimitCents: number | null;
  enforcedForPaidSearch: boolean;
  limitsStatus: "loading" | "ready" | "error";
  pricingStatus?: "READY" | "MODEL_PRICING_UNAVAILABLE" | "AI_SETTINGS_REQUIRED" | "RESEARCH_DISABLED" | "INSUFFICIENT_APP_BUDGET";
  selectedProvider?: string; selectedModel?: string;
  savedProvider?: string | null; savedModel?: string | null;
}): { steps: ResearchReadinessStep[]; ready: boolean };
