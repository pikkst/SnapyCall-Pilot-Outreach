// Private lease coordinator. It does not call AI providers, ingest contacts,
// resolve URLs or authorize sending. Caller must authenticate the worker and
// check workspace ownership and spend authorization before any paid execution.
import { randomUUID } from "node:crypto";

const MAX_ATTEMPTS = 3;
const LEASE_MS = 120_000;

export function boundedRetryDelayMs(attempt) {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_ATTEMPTS) {
    throw new TypeError("Invalid task attempt count");
  }
  return Math.min(60_000, 2_000 * 2 ** (attempt - 1));
}

export function classifyTaskFailure(code, attempt, now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      !Number.isInteger(attempt) || attempt < 1 || attempt > MAX_ATTEMPTS) {
    throw new TypeError("Invalid task failure context");
  }
  // Authorization, budget and uncertain provider billing MUST NOT be retried.
  const retryable = code === "PROVIDER_429" || code === "PROVIDER_5XX";
  const retry = retryable && attempt < MAX_ATTEMPTS;
  return Object.freeze({
    status: retry ? "QUEUED" : "PAUSED",
    nextAttemptAt: retry ? new Date(now.getTime() + boundedRetryDelayMs(attempt)) : null,
    lastErrorCode: [
      "PROVIDER_429", "PROVIDER_5XX", "PERMISSION_REVOKED",
      "BUDGET_EXHAUSTED", "BILLING_UNCERTAIN", "PROVIDER_INVALID_RESPONSE",
    ].includes(code) ? code : "UNCLASSIFIED",
  });
}

// Claim one queued task within an exact campaign. PostgreSQL row lock prevents
// two workers from claiming the same task across instances. Expired RUNNING
// leases are intentionally NOT auto-retried: the upstream may already bill.
export async function claimResearchTask(db, { campaignId, workspaceId, ownerId,
  now = new Date() }) {
  if (![campaignId, workspaceId, ownerId].every(value =>
    typeof value === "string" && /^c[a-z0-9]{10,40}$/.test(value)) ||
    !(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("Verified campaign scope and clock required");
  }
  return db.$transaction(async tx => {
    const campaign = await tx.researchCampaign.findFirst({
      where: { id: campaignId, workspaceId, ownerId, status: {
        in: ["QUEUED", "RUNNING"],
      } },
      select: { id: true },
    });
    if (!campaign) return null;
    const rows = await tx.$queryRaw`
      SELECT "id", "attempts", "query", "resultLimit"
      FROM "ResearchCampaignTask"
      WHERE "campaignId" = ${campaignId}
        AND "status" = 'QUEUED'
        AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= ${now})
        AND "attempts" < ${MAX_ATTEMPTS}
      ORDER BY "taskIndex" ASC
      LIMIT 1 FOR UPDATE SKIP LOCKED`;
    if (rows.length !== 1) return null;
    const task = rows[0];
    const token = randomUUID();
    const leaseUntil = new Date(now.getTime() + LEASE_MS);
    await tx.researchCampaignTask.update({
      where: { id: task.id },
      data: { status: "RUNNING", attempts: { increment: 1 },
        leaseToken: token, leaseUntil, nextAttemptAt: null,
        lastErrorCode: null },
    });
    await tx.researchCampaign.updateMany({
      where: { id: campaignId, workspaceId, ownerId, status: "QUEUED" },
      data: { status: "RUNNING" },
    });
    return { taskId: task.id, campaignId, workspaceId, ownerId,
      query: task.query, limit: task.resultLimit,
      attempt: task.attempts + 1, leaseToken: token, leaseUntil };
  });
}

// Fencing tokens reject stale, cancelled or duplicated completions. Caller
// must commit evidence observations in the SAME transaction in the executor.
export async function completeResearchTask(tx, claim, { observedCount, now = new Date() }) {
  if (!Number.isInteger(observedCount) || observedCount < 0 ||
    observedCount > claim.limit || !(now instanceof Date) ||
    !Number.isFinite(now.getTime())) {
    throw new TypeError("Invalid task result count");
  }
  const updated = await tx.researchCampaignTask.updateMany({
    where: { id: claim.taskId, campaignId: claim.campaignId,
      leaseToken: claim.leaseToken, status: "RUNNING", leaseUntil: { gt: now },
      campaign: { workspaceId: claim.workspaceId, ownerId: claim.ownerId,
        status: "RUNNING" } },
    data: { status: "COMPLETED", observedCount, completedAt: now,
      leaseToken: null, leaseUntil: null },
  });
  return updated.count === 1;
}

export async function failResearchTask(tx, claim, code, now = new Date()) {
  const next = classifyTaskFailure(code, claim.attempt, now);
  const updated = await tx.researchCampaignTask.updateMany({
    where: { id: claim.taskId, campaignId: claim.campaignId,
      leaseToken: claim.leaseToken, status: "RUNNING", leaseUntil: { gt: now },
      campaign: { workspaceId: claim.workspaceId, ownerId: claim.ownerId,
        status: "RUNNING" } },
    data: { ...next, leaseToken: null, leaseUntil: null },
  });
  return { applied: updated.count === 1, ...next };
}
