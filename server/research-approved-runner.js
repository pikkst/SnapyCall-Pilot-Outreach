// One DB-persisted campaign per tick. Designed for a single Render process.
// It is restart-safe at the DB lease boundary but availability requires a
// continuously running worker/scheduler; a sleeping free instance is NOT one.
import { runOneCampaignTask } from "./research-campaign-worker.js";
import { ResearchPacingRequired, ResearchQuotaExceeded } from "./research-quota.js";
import { finishApprovedRunTask, pauseApprovedRun,
  ApprovedRunBlocked } from "./research-campaign-run-approval.js";

export async function tickApprovedCampaignRun(db, {
  encryptionKey, runTask = runOneCampaignTask,
  finish = finishApprovedRunTask,
  pause = pauseApprovedRun,
} = {}) {
  if (typeof encryptionKey !== "string" || encryptionKey.length < 16 ||
      typeof runTask !== "function" || typeof finish !== "function" ||
      typeof pause !== "function") {
    throw new TypeError("Trusted worker configuration required");
  }
  const eligible = await db.researchCampaignRun.findFirst({
    where: { status: { in: ["APPROVED", "RUNNING"] } },
    select: { campaignId: true, workspaceId: true, ownerId: true },
    // Updating the run after each tick rotates active campaigns fairly.
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
  });
  if (!eligible) return { status: "IDLE" };
  const scope = {
    campaignId: eligible.campaignId,
    workspaceId: eligible.workspaceId,
    ownerId: eligible.ownerId,
  };
  try {
    const result = await runTask(db, {
      ...scope, encryptionKey, autonomousApproved: true,
    });
    await finish(db, { ...scope, result });
    return { status: result.status, code: result.code ?? null };
  } catch (error) {
    if (error instanceof ResearchPacingRequired) {
      // The failed transaction reserved no money, quota or task claim.
      // Persist an informational wait under the normal membership and
      // campaign row locks; do not pause or consume fresh authorization.
      const waiting = await finish(db, {
        ...scope, result: { status: "RATE_LIMIT_WAIT", attempted: false },
      });
      return { status: waiting.code === "RUNNING" ? "WAITING" : waiting.code,
        code: waiting.lastCode ?? error.code,
        retryAfterSeconds: error.retryAfterSeconds };
    }
    if (error instanceof ResearchQuotaExceeded) {
      // The entire claim transaction rolled back. No task, owner budget,
      // daily quota or provider dispatch was committed in this tick.
      // Preserve the immutable approval and recheck after the UTC day resets.
      const waiting = await finish(db, {
        ...scope, result: { status: "DAILY_QUOTA_WAIT", attempted: false },
      });
      return { status: waiting.code === "RUNNING" ? "WAITING" : waiting.code,
        code: waiting.lastCode ?? "WAITING_DAILY_QUOTA" };
    }
    if (error instanceof ApprovedRunBlocked &&
        error.code === "RUN_TASK_ALREADY_IN_FLIGHT") {
      return { status: "IN_FLIGHT" };
    }
    // Provider/DB errors may be post-dispatch. Never replay them.
    // A failed pause itself is allowed to bubble; we still do NOT run another
    // task in this tick and reconciliation is required on the next boot.
    await pause(db, {
      ...scope, code: error instanceof ApprovedRunBlocked &&
        ["RUN_PRICE_OR_MODEL_CHANGED", "RUN_APPROVAL_EXPIRED"].includes(error.code)
        ? error.code
        : "RUN_EXECUTION_UNCERTAIN",
    });
    return { status: "PAUSED", code: "RUN_EXECUTION_UNCERTAIN" };
  }
}

export function startApprovedCampaignWorker(db, {
  encryptionKey, intervalMs = 8000,
  runTick = tickApprovedCampaignRun,
  schedule = setInterval, cancel = clearInterval,
} = {}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 5000 ||
      intervalMs > 60000 || typeof runTick !== "function" ||
      typeof schedule !== "function" || typeof cancel !== "function") {
    throw new TypeError("Invalid worker interval or scheduler");
  }
  let stopped = false;
  let activeTick = null;
  // A timer callback may already be inside a paid provider call when Render
  // sends SIGTERM. Stop admitting new work, but allow the current promise to
  // settle its existing reservation and fenced task before disconnecting DB.
  async function tick() {
    if (stopped || activeTick) return;
    const work = Promise.resolve().then(() => runTick(db, { encryptionKey }));
    activeTick = work;
    try {
      await work;
    } catch {
      // Provider uncertainty remains in the existing no-replay path.
      console.warn("[research-run] Worker tick failed; no automatic provider retry");
    } finally {
      if (activeTick === work) activeTick = null;
    }
  }
  const interval = schedule(() => { void tick(); }, intervalMs);
  // Intentionally no immediate paid call during startup.
  return () => {
    stopped = true;
    cancel(interval);
    return activeTick ? activeTick.catch(() => {}) : Promise.resolve();
  };
}
