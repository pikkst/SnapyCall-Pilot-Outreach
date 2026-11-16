// A single explicitly approved browser test batch. Every step uses the
// existing one-task API and independently checks server state and spend.
// Never schedule a background loop or replay an uncertain provider result.
export const MAX_APPROVED_CAMPAIGN_BATCH_TASKS = 5;

export async function runApprovedCampaignBatch({
  maxTasks, readState, execute, shouldStop = () => false,
  onProgress = () => {},
}) {
  if (!Number.isInteger(maxTasks) || maxTasks < 1 ||
      maxTasks > MAX_APPROVED_CAMPAIGN_BATCH_TASKS ||
      typeof readState !== "function" || typeof execute !== "function" ||
      typeof shouldStop !== "function" || typeof onProgress !== "function") {
    throw new TypeError("Invalid approved campaign batch");
  }
  let completed = 0;
  for (let i = 0; i < maxTasks; i++) {
    if (shouldStop()) return { status: "STOPPED", completed };
    // Readiness comes from a fresh workspace-scoped server projection. The
    // backend still rechecks permissions, quota and money inside every claim.
    const state = await readState();
    if (shouldStop()) return { status: "STOPPED", completed };
    if (!state || state.operationalState !== "READY" ||
        state.needsReconciliation || state.budgetReady !== true) {
      return { status: "NOT_READY", completed };
    }
    // An API failure or ambiguous network outcome is propagated and never
    // retried automatically; already committed tasks remain durable.
    await execute();
    completed++;
    await onProgress(completed);
  }
  return { status: "BATCH_COMPLETED", completed };
}
