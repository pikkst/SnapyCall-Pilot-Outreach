// One DB-persisted campaign per tick. Designed for a single Render process.
// It is restart-safe at the DB lease boundary but availability requires a
// continuously running worker/scheduler; a sleeping free instance is NOT one.
import { runOneCampaignTask } from "./research-campaign-worker.js";
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
    orderBy: [{ approvedAt: "asc" }, { id: "asc" }],
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
    if (error instanceof ApprovedRunBlocked &&
        error.code === "RUN_TASK_ALREADY_IN_FLIGHT") {
      return { status: "IN_FLIGHT" };
    }
    // Provider/DB errors may be post-dispatch. Never replay them.
    // A failed pause itself is allowed to bubble; we still do NOT run another
    // task in this tick and reconciliation is required on the next boot.
    await pause(db, {
      ...scope, code: error instanceof ApprovedRunBlocked &&
        error.code === "RUN_PRICE_OR_MODEL_CHANGED"
        ? "RUN_PRICE_OR_MODEL_CHANGED"
        : "RUN_EXECUTION_UNCERTAIN",
    });
    return { status: "PAUSED", code: "RUN_EXECUTION_UNCERTAIN" };
  }
}

export function startApprovedCampaignWorker(db, {
  encryptionKey, intervalMs = 8000,
} = {}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 5000 ||
      intervalMs > 60000) throw new TypeError("Invalid worker interval");
  let busy = false;
  let stopped = false;
  async function tick() {
    if (stopped || busy) return;
    busy = true;
    try {
      await tickApprovedCampaignRun(db, { encryptionKey });
    } catch {
      // Fail closed. One process log line is intentionally sanitized.
      console.warn("[research-run] Worker tick failed; no automatic provider retry");
    } finally {
      busy = false;
    }
  }
  const interval = setInterval(() => { void tick(); }, intervalMs);
  // Intentionally no immediate paid call during startup. The next timer tick
  // rehydrates persisted approval and runs after the server is fully online.
  return () => {
    stopped = true;
    clearInterval(interval);
  };
}
