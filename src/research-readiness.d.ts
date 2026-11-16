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
}): { steps: ResearchReadinessStep[]; ready: boolean };
