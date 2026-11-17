export type CampaignStageStatus =
  "ACTIVE" | "NEEDS_ATTENTION" | "FINISHED" | "QUEUED" |
  "AWAITING_STATE" | "REVIEW_AVAILABLE" | "WAITING" |
  "MANUAL_ONLY" | "DISABLED";

export interface CampaignStagePresentation {
  key: string;
  title: string;
  status: CampaignStageStatus;
  detail: string;
}

export function campaignStageTimeline(progress: {
  targetCount: number;
  uniqueSourcedCandidates: number;
  operationalState: string;
  needsReconciliation: boolean;
  tasks: { running: number; queued: number };
}): readonly CampaignStagePresentation[];
