// Explicit operator decision to abandon one previously charged/uncertain
// research task WITHOUT replay. This never refunds or changes spend totals.
// Permission, campaign/task and ledger proof are checked transactionally.
import { lockActiveWorkspaceMembership } from "./workspace-access.js";

const CUID = /^c[a-z0-9]{10,40}$/;

export async function skipPausedResearchTask(db, {
  campaignId, workspaceId, ownerId, taskIndex,
  confirmNoRetry, acceptConservativeCharge,
}, { now = () => new Date() } = {}) {
  if (![campaignId, workspaceId, ownerId].every(v =>
    typeof v === "string" && CUID.test(v)) ||
    !Number.isInteger(taskIndex) || taskIndex < 0 || taskIndex >= 100 ||
    confirmNoRetry !== true || acceptConservativeCharge !== true ||
    typeof now !== "function") throw new TypeError("Explicit scoped reconciliation required");
  const clock = now();
  if (!(clock instanceof Date) || !Number.isFinite(clock.getTime())) {
    throw new TypeError("Invalid reconciliation clock");
  }
  return db.$transaction(async tx => {
    if (!await lockActiveWorkspaceMembership(tx, { workspaceId, userId: ownerId })) {
      return { status: 403, code: "WORKSPACE_ACCESS_REVOKED" };
    }
    const campaigns = await tx.$queryRaw`
      SELECT "id" FROM "ResearchCampaign"
      WHERE "id" = ${campaignId} AND "workspaceId" = ${workspaceId}
        AND "ownerId" = ${ownerId} AND "status" = 'RUNNING'
      FOR UPDATE`;
    if (campaigns.length !== 1) return { status: 409, code: "CAMPAIGN_NOT_RUNNING" };
    // Refuse to abandon a task while any potentially chargeable execution
    // is still active. Row locking follows existing campaign-first order.
    const running = await tx.researchCampaignTask.count({
      where: { campaignId, status: "RUNNING" },
    });
    if (running !== 0) return { status: 409, code: "RUNNING_TASK_REQUIRES_REVIEW" };
    const rows = await tx.$queryRaw`
      SELECT "id", "status", "lastErrorCode", "leaseToken", "leaseUntil",
             "observedCount", "attempts"
      FROM "ResearchCampaignTask"
      WHERE "campaignId" = ${campaignId} AND "taskIndex" = ${taskIndex}
      FOR UPDATE`;
    if (rows.length !== 1) return { status: 404, code: "TASK_NOT_FOUND" };
    const task = rows[0];
    if (task.status === "CANCELLED" && task.lastErrorCode === "BILLING_UNCERTAIN") {
      return { status: 200, code: "ALREADY_SKIPPED", changed: false,
        sendingEnabled: false };
    }
    if (task.status !== "PAUSED" || task.lastErrorCode !== "BILLING_UNCERTAIN" ||
        task.leaseToken !== null || task.leaseUntil !== null ||
        task.observedCount !== 0 || task.attempts < 1) {
      return { status: 409, code: "TASK_NOT_SAFE_TO_SKIP" };
    }
    const evidenceCount = await tx.researchCampaignObservation.count({
      where: { campaignId, taskId: task.id },
    });
    if (evidenceCount !== 0) {
      return { status: 409, code: "TASK_HAS_COMMITTED_OBSERVATIONS" };
    }
    // Audit event is the existing source binding a spend reservation to its
    // task; the reservation schema itself has no taskId foreign key.
    const events = await tx.auditEvent.findMany({
      where: { action: "research.campaign.spend.reserved",
        metadata: { path: ["campaignId"], equals: campaignId } },
      select: { entityId: true, metadata: true },
      take: 100,
    });
    const matched = events.filter(event =>
      event.metadata?.workspaceId === workspaceId &&
      event.metadata?.taskId === task.id);
    // More than one paid attempt requires a separate multi-charge review.
    if (matched.length !== 1 || typeof matched[0].entityId !== "string") {
      return { status: 409, code: "SPEND_TRACE_AMBIGUOUS" };
    }
    const spend = await tx.researchSpendReservation.findUnique({
      where: { id: matched[0].entityId },
    });
    if (!spend || spend.ownerId !== ownerId ||
        spend.workspaceId !== workspaceId ||
        spend.status !== "SETTLED" ||
        spend.settledAt == null ||
        !Number.isSafeInteger(spend.reservedCents) ||
        spend.reservedCents <= 0 ||
        spend.chargedCents !== spend.reservedCents) {
      return { status: 409, code: "SPEND_RECONCILIATION_REQUIRED" };
    }
    const written = await tx.researchCampaignTask.updateMany({
      where: { id: task.id, campaignId, status: "PAUSED",
        lastErrorCode: "BILLING_UNCERTAIN", leaseToken: null,
        leaseUntil: null, observedCount: 0 },
      data: { status: "CANCELLED", nextAttemptAt: null },
    });
    if (written.count !== 1) {
      return { status: 409, code: "TASK_STATE_CHANGED" };
    }
    await tx.auditEvent.create({ data: {
      actorId: ownerId, action: "research.campaign.uncertain-task-skipped",
      entityId: task.id, metadata: {
        campaignId, workspaceId, taskIndex,
        previousErrorCode: "BILLING_UNCERTAIN",
        acceptedConservativeCents: spend.chargedCents,
        externalProviderChargeVerified: false,
        replayPermitted: false, sendingEnabled: false,
      },
    } });
    return { status: 200, code: "UNCERTAIN_TASK_SKIPPED",
      changed: true, taskIndex,
      conservativeChargeCents: spend.chargedCents,
      externalProviderChargeVerified: false,
      sendingEnabled: false };
  });
}
