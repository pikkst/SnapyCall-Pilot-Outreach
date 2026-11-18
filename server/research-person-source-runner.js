// Optional always-on worker for previously approved source-resolution stages.
// No provider calls are scheduled without the immutable owner-scoped approval,
// exact price, daily quota and monthly budget checks inside the executor.
import { lockActiveWorkspaceMembership }
  from "./workspace-access.js";
import { runOnePersonSourceJob }
  from "./research-person-source-executor.js";
import { verifyPersonSourceProposal }
  from "./research-person-source-evidence.js";

const REVIEW_CODES = new Set([
  "SHARED_SOURCE_REQUIRES_REVIEW", "SOURCE_OBSERVATION_CHANGED",
  "SOURCE_JOB_CHANGED", "DIRECT_PERSON_SOURCE_REQUIRED",
]);
const FINAL_STATES = new Set([
  "VERIFIED", "SOURCE_NOT_ATTRIBUTABLE", "SOURCE_UNAVAILABLE",
  "SOURCE_REVIEW_REQUIRED", "COMPLETED",
]);

export async function quarantineUnverifiablePersonSource(db, scope, code) {
  if (!REVIEW_CODES.has(code)) {
    throw new TypeError("Only deterministic source evidence conflicts may be quarantined");
  }
  return db.$transaction(async tx => {
    if (!await lockActiveWorkspaceMembership(tx, {
      workspaceId: scope.workspaceId, userId: scope.ownerId,
    })) return { status: "BLOCKED", code: "WORKSPACE_ACCESS_REVOKED" };
    const campaign = await tx.$queryRaw`
      SELECT "id" FROM "ResearchCampaign" WHERE "id" = ${scope.campaignId}
        AND "workspaceId" = ${scope.workspaceId}
        AND "ownerId" = ${scope.ownerId}
        AND "status" IN ('PARTIAL', 'COMPLETED') FOR UPDATE`;
    if (campaign.length !== 1) {
      return { status: "BLOCKED", code: "CAMPAIGN_NOT_FOUND" };
    }
    const approved = await tx.researchPersonSourceApproval.findUnique({
      where: { campaignId: scope.campaignId },
    });
    if (!approved || approved.ownerId !== scope.ownerId ||
        approved.workspaceId !== scope.workspaceId ||
        approved.publicInspectionAuthorized !== true ||
        !["APPROVED", "RUNNING"].includes(approved.status)) {
      return { status: "BLOCKED", code: "PUBLIC_INSPECTION_NOT_AUTHORIZED" };
    }
    const updated = await tx.researchPersonSourceJob.updateMany({
      where: { id: scope.jobId, campaignId: scope.campaignId,
        status: "COMPLETED", proposedSourceUrl: { not: null } },
      data: { status: "SOURCE_REVIEW_REQUIRED", lastErrorCode: code },
    });
    if (updated.count !== 1) {
      return { status: "BLOCKED", code: "SOURCE_JOB_ALREADY_CHANGED" };
    }
    await tx.auditEvent.create({ data: {
      actorId: scope.ownerId, entityId: scope.jobId,
      action: "research.person-source.review-required",
      metadata: { workspaceId: scope.workspaceId,
        campaignId: scope.campaignId, code,
        automaticRetry: false, contactCreated: false, sendingEnabled: false },
    } });
    return { status: "REVIEW_REQUIRED", code };
  });
}

export async function finalizePersonSourceStage(db, scope) {
  return db.$transaction(async tx => {
    if (!await lockActiveWorkspaceMembership(tx, {
      workspaceId: scope.workspaceId, userId: scope.ownerId,
    })) return { status: "BLOCKED", code: "WORKSPACE_ACCESS_REVOKED" };
    const campaign = await tx.$queryRaw`
      SELECT "id" FROM "ResearchCampaign" WHERE "id" = ${scope.campaignId}
        AND "workspaceId" = ${scope.workspaceId}
        AND "ownerId" = ${scope.ownerId}
        AND "status" IN ('PARTIAL', 'COMPLETED') FOR UPDATE`;
    if (campaign.length !== 1) {
      return { status: "BLOCKED", code: "CAMPAIGN_NOT_FOUND" };
    }
    const approval = await tx.researchPersonSourceApproval.findUnique({
      where: { campaignId: scope.campaignId },
    });
    if (!approval || approval.ownerId !== scope.ownerId ||
        approval.workspaceId !== scope.workspaceId ||
        !["APPROVED", "RUNNING"].includes(approval.status)) {
      return { status: "BLOCKED", code: "PERSON_SOURCE_APPROVAL_INACTIVE" };
    }
    const jobs = await tx.researchPersonSourceJob.findMany({
      where: { campaignId: scope.campaignId },
      select: { status: true, proposedSourceUrl: true }, take: 251,
    });
    if (jobs.length !== approval.eligibleJobCount || jobs.length > 250) {
      return { status: "BLOCKED", code: "SOURCE_JOB_SNAPSHOT_CHANGED" };
    }
    if (jobs.some(job => ["RUNNING", "PAUSED"].includes(job.status) ||
        (job.status === "COMPLETED" && job.proposedSourceUrl))) {
      return { status: "WAITING", code: "SOURCE_JOB_RECONCILIATION_OR_INSPECTION" };
    }
    const outstanding = jobs.filter(job => job.status === "QUEUED").length;
    const exhausted = approval.startedCalls >= approval.maxCalls ||
      approval.committedWorstCaseCents + approval.worstCasePerCallCents >
        approval.maxWorstCaseCents;
    if (outstanding && !exhausted) {
      return { status: "WAITING", code: "MORE_SOURCE_JOBS_AVAILABLE" };
    }
    const terminal = outstanding ? "PARTIAL_BUDGET" : "COMPLETED";
    if (jobs.some(job => !FINAL_STATES.has(job.status) &&
        job.status !== "QUEUED")) {
      return { status: "BLOCKED", code: "UNKNOWN_SOURCE_JOB_STATE" };
    }
    const changed = await tx.researchPersonSourceApproval.updateMany({
      where: { id: approval.id, campaignId: scope.campaignId,
        workspaceId: scope.workspaceId, ownerId: scope.ownerId,
        status: { in: ["APPROVED", "RUNNING"] } },
      data: { status: terminal },
    });
    if (changed.count !== 1) {
      return { status: "BLOCKED", code: "SOURCE_RUN_FINALIZATION_CONFLICT" };
    }
    await tx.auditEvent.create({ data: {
      actorId: scope.ownerId, entityId: approval.id,
      action: "research.person-source.run.finalized",
      metadata: { workspaceId: scope.workspaceId,
        campaignId: scope.campaignId, status: terminal,
        inspected: jobs.filter(job => job.status === "VERIFIED").length,
        pending: outstanding, automaticBillableRetry: false,
        sendingEnabled: false },
    } });
    return { status: terminal, code: "SOURCE_STAGE_TERMINAL" };
  });
}

export async function tickPersonSourcePipeline(db, {
  encryptionKey, runTask = runOnePersonSourceJob,
  inspect = verifyPersonSourceProposal,
  quarantine = quarantineUnverifiablePersonSource,
  finalize = finalizePersonSourceStage,
} = {}) {
  if (typeof encryptionKey !== "string" || encryptionKey.length < 16 ||
      [runTask, inspect, quarantine, finalize].some(fn =>
        typeof fn !== "function")) {
    throw new TypeError("Trusted person-source worker configuration required");
  }
  const approval = await db.researchPersonSourceApproval.findFirst({
    where: { status: { in: ["APPROVED", "RUNNING"] },
      publicInspectionAuthorized: true, expiresAt: { gt: new Date() } },
    select: { campaignId: true, workspaceId: true, ownerId: true },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
  });
  if (!approval) return { status: "IDLE" };
  const scope = { campaignId: approval.campaignId,
    workspaceId: approval.workspaceId, ownerId: approval.ownerId };
  // Non-billable proof goes first. Restart rehydrates a persisted provider
  // proposal instead of repeating the paid provider call.
  const pending = await db.researchPersonSourceJob.findFirst({
    where: { campaignId: scope.campaignId, status: "COMPLETED",
      proposedSourceUrl: { not: null } },
    select: { id: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (pending) {
    const verificationScope = { ...scope, jobId: pending.id };
    const result = await inspect(db, verificationScope);
    if (REVIEW_CODES.has(result.code)) {
      return quarantine(db, verificationScope, result.code);
    }
    return { status: result.status === 200
      ? result.qualifiedEvidence ? "QUALIFIED_EVIDENCE" : "SOURCE_INSPECTED"
      : "BLOCKED", code: result.code };
  }
  try {
    const paid = await runTask(db, { ...scope, encryptionKey });
    if (paid.status === "IDLE" ||
        (paid.status === "BLOCKED" &&
        ["SOURCE_APPROVED_SPEND_EXHAUSTED", "NO_SOURCE_JOB_READY"].includes(
          paid.code))) {
      return finalize(db, scope);
    }
    return { status: paid.status, code: paid.code ?? null };
  } catch (error) {
    // Pacing and preflight failures do not grant permission to retry a
    // possibly billable provider call. A claimed job is already fenced.
    return { status: "BLOCKED",
      code: error?.code === "RESEARCH_PACING_WAIT"
        ? "RESEARCH_PACING_WAIT" : "SOURCE_WORKER_RECONCILIATION_REQUIRED" };
  }
}

export function startPersonSourceWorker(db, {
  encryptionKey, intervalMs = 8000,
} = {}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 5000 ||
      intervalMs > 60000) throw new TypeError("Invalid worker interval");
  let busy = false;
  let stopped = false;
  async function tick() {
    if (busy || stopped) return;
    busy = true;
    try { await tickPersonSourcePipeline(db, { encryptionKey }); }
    catch { console.warn("[person-source] Worker requires operator review"); }
    finally { busy = false; }
  }
  const handle = setInterval(() => { void tick(); }, intervalMs);
  // Startup never automatically initiates a paid call before the first tick.
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}
