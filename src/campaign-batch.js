// A single explicit user-approved campaign run. Every billable task uses the
// existing server-side lease, membership, quota and monetary reservations.
// The browser must remain open: this is NOT a background scheduler.
export const MAX_APPROVED_CAMPAIGN_BATCH_TASKS = 24;
// 10 execute-next requests / minute on the server; avoid bursts before
// entering Express, allowing 9/min plus latency tolerance.
export const MIN_START_INTERVAL_MS = 35_000;
export const MAX_PACING_WAITS_PER_TASK = 5;

// Only the server's explicit no-dispatch code authorizes waiting and resending
// execute-next. All network, timeout, billing and unknown HTTP errors remain
// non-retryable because the provider request may already have been charged.
export class ResearchPacingWait extends Error {
  constructor(retryAfterSeconds) {
    if (!Number.isInteger(retryAfterSeconds) || retryAfterSeconds < 1 ||
        retryAfterSeconds > 120) {
      throw new TypeError("Untrusted research pacing delay");
    }
    super("Research safely waiting for the next AI dispatch window");
    this.name = "ResearchPacingWait";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

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
    let pacingWaits = 0;
    while (true) {
      if (shouldStop()) return { status: "STOPPED", completed };
      if (lastStart !== null) {
        const elapsed = now() - lastStart;
        const delay = Math.max(0, MIN_START_INTERVAL_MS - elapsed);
        if (delay > 0) {
          await onWaiting(delay);
          await wait(delay);
          if (shouldStop()) return { status: "STOPPED", completed };
          // Never carry a stale budget or authorization across a wait.
          const fresh = await readState();
          if (shouldStop()) return { status: "STOPPED", completed };
          if (!fresh || fresh.operationalState !== "READY" ||
              fresh.needsReconciliation || fresh.budgetReady !== true) {
            return { status: "NOT_READY", completed,
              operationalState: fresh?.operationalState ?? "UNAVAILABLE" };
          }
        }
      }
      const attemptedAt = now();
      try {
        // Only a completed response advances a paid task. Generic errors
        // after dispatch are always propagated without automatic replay.
        await execute();
        lastStart = attemptedAt;
        completed++;
        await onProgress(completed);
        break;
      } catch (error) {
        if (!(error instanceof ResearchPacingWait)) throw error;
        if (++pacingWaits > MAX_PACING_WAITS_PER_TASK) {
          return { status: "WAITING", completed,
            retryAfterSeconds: error.retryAfterSeconds };
        }
        const delay = error.retryAfterSeconds * 1000;
        await onWaiting(delay);
        // The exact server code proves no AI dispatch occurred. This is the
        // only case where retrying execute-next is allowed.
        await wait(delay);
        if (shouldStop()) return { status: "STOPPED", completed };
        const fresh = await readState();
        if (shouldStop()) return { status: "STOPPED", completed };
        if (!fresh || fresh.operationalState !== "READY" ||
            fresh.needsReconciliation || fresh.budgetReady !== true) {
          return { status: "NOT_READY", completed,
            operationalState: fresh?.operationalState ?? "UNAVAILABLE" };
        }
      }
    }
  }
  // The last successful task may have finalized the campaign. Reflect the
  // durable server state instead of describing a completed plan as a limit.
  const final = await readState();
  if (shouldStop()) return { status: "STOPPED", completed };
  if (final?.operationalState !== "READY" || final?.needsReconciliation ||
      final?.budgetReady !== true) {
    return { status: "NOT_READY", completed,
      operationalState: final?.operationalState ?? "UNAVAILABLE" };
  }
  return { status: "RUN_LIMIT_REACHED", completed };
}
