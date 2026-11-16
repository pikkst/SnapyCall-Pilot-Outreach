// A single explicit user-approved campaign run. Every billable task uses the
// existing server-side lease, membership, quota and monetary reservations.
// The browser must remain open: this is NOT a background scheduler.
export const MAX_APPROVED_CAMPAIGN_BATCH_TASKS = 24;
// 10 execute-next requests / minute on the server; avoid bursts before
// entering Express, allowing 9/min plus latency tolerance.
export const MIN_START_INTERVAL_MS = 7_000;

export async function runApprovedCampaignBatch({
  maxTasks, readState, execute, shouldStop = () => false,
  onProgress = () => {}, onWaiting = () => {},
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = () => Date.now(),
}) {
  if (!Number.isInteger(maxTasks) || maxTasks < 1 ||
      maxTasks > MAX_APPROVED_CAMPAIGN_BATCH_TASKS ||
      typeof readState !== "function" || typeof execute !== "function" ||
      typeof shouldStop !== "function" || typeof onProgress !== "function" ||
      typeof onWaiting !== "function" || typeof wait !== "function" ||
      typeof now !== "function") {
    throw new TypeError("Invalid approved campaign run");
  }
  let completed = 0;
  let lastStart = null;
  for (let index = 0; index < maxTasks; index++) {
    if (shouldStop()) return { status: "STOPPED", completed };
    const state = await readState();
    if (shouldStop()) return { status: "STOPPED", completed };
    if (!state || state.operationalState !== "READY" ||
        state.needsReconciliation || state.budgetReady !== true) {
      return { status: "NOT_READY", completed,
        operationalState: state?.operationalState ?? "UNAVAILABLE" };
    }
    if (lastStart !== null) {
      const elapsed = now() - lastStart;
      const delay = Math.max(0, MIN_START_INTERVAL_MS - elapsed);
      if (delay > 0) {
        await onWaiting(delay);
        // Waiting is not a provider retry; any cancellation here prevents
        // the next chargeable call.
        await wait(delay);
        if (shouldStop()) return { status: "STOPPED", completed };
        // No mutable proof is trusted across a wait; recheck authorization
        // and readiness before initiating another chargeable request.
        const fresh = await readState();
        if (shouldStop()) return { status: "STOPPED", completed };
        if (!fresh || fresh.operationalState !== "READY" ||
            fresh.needsReconciliation || fresh.budgetReady !== true) {
          return { status: "NOT_READY", completed,
            operationalState: fresh?.operationalState ?? "UNAVAILABLE" };
        }
      }
    }
    lastStart = now();
    // An API/network error after dispatch may represent a completed paid call.
    // Propagate it without retries or an automatic follow-up call.
    await execute();
    completed++;
    await onProgress(completed);
  }
  return { status: "RUN_LIMIT_REACHED", completed };
}
