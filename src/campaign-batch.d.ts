export type CampaignBatchState = {
  operationalState: string;
  needsReconciliation: boolean;
  budgetReady: boolean;
};
export type CampaignBatchOutcome = {
  status: "STOPPED" | "NOT_READY" | "RUN_LIMIT_REACHED" | "WAITING";
  completed: number;
  operationalState?: string;
  retryAfterSeconds?: number;
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

/** Only an explicit server-confirmed HTTP 429 no-dispatch pacing response. */
export class ResearchPacingWait extends Error {
  constructor(retryAfterSeconds: number);
  readonly retryAfterSeconds: number;
}
export const MAX_PACING_WAITS_PER_TASK: number;
export const MIN_START_INTERVAL_MS: number;
