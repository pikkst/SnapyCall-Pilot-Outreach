export type CampaignBatchState = {
  operationalState: string;
  needsReconciliation: boolean;
  budgetReady: boolean;
};
export type CampaignBatchOutcome = {
  status: "STOPPED" | "NOT_READY" | "BATCH_COMPLETED";
  completed: number;
};
export function runApprovedCampaignBatch(input: {
  maxTasks: number;
  readState: () => Promise<CampaignBatchState>;
  execute: () => Promise<unknown>;
  shouldStop?: () => boolean;
  onProgress?: (completed: number) => void | Promise<void>;
}): Promise<CampaignBatchOutcome>;
