export type CampaignBatchState = {
  operationalState: string;
  needsReconciliation: boolean;
  budgetReady: boolean;
};
export type CampaignBatchOutcome = {
  status: "STOPPED" | "NOT_READY" | "RUN_LIMIT_REACHED";
  completed: number;
  operationalState?: string;
};
export function runApprovedCampaignBatch(input: {
  maxTasks: number;
  readState: () => Promise<CampaignBatchState>;
  execute: () => Promise<unknown>;
  shouldStop?: () => boolean;
  onProgress?: (completed: number) => void | Promise<void>;
  onWaiting?: (milliseconds: number) => void | Promise<void>;
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}): Promise<CampaignBatchOutcome>;
