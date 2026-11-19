// Explicit operator decision to abandon one previously charged/uncertain
// research task WITHOUT replay. This never refunds or changes spend totals.
// Permission, campaign/task and ledger proof are checked transactionally.
import { lockActiveWorkspaceMembership, requireWorkspaceMembership } from "./workspace-access.js";

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

// Read-only operator assessment of expired/paused Discovery leases.
// This NEVER settles a reservation, resets a task or authorizes another call.
// An absent dispatch-intent audit on older runs does not prove no billing.
export async function inspectDiscoveryLeaseReconciliation(db, {
  campaignId, workspaceId, ownerId,
}, { now = () => new Date(), membership = requireWorkspaceMembership } = {}) {
  if (![campaignId, workspaceId, ownerId].every(v =>
    typeof v === "string" && CUID.test(v)) ||
    typeof now !== "function" || typeof membership !== "function") {
    throw new TypeError("Valid scoped Discovery reconciliation required");
  }
  const clock = now();
  if (!(clock instanceof Date) || !Number.isFinite(clock.getTime())) {
    throw new TypeError("Invalid reconciliation clock");
  }
  if (!await membership(db, { userId: ownerId, workspaceId })) {
    return { status: 403, code: "WORKSPACE_ACCESS_REVOKED" };
  }
  const full = await db.researchFullRun.findUnique({
    where: { campaignId },
    select: { workspaceId: true, ownerId: true, status: true, lastCode: true },
  });
  if (!full || full.workspaceId !== workspaceId || full.ownerId !== ownerId) {
    return { status: 404, code: "FULL_RUN_NOT_FOUND" };
  }
  const tasks = await db.researchCampaignTask.findMany({
    where: { campaignId, status: { in: ["RUNNING", "PAUSED"] } },
    select: { id: true, taskIndex: true, status: true, attempts: true,
      leaseUntil: true, observedCount: true, lastErrorCode: true },
    orderBy: { taskIndex: "asc" },
    take: 26,
  });
  if (tasks.length > 25) {
    return { status: 409, code: "RECONCILIATION_SCOPE_TOO_LARGE" };
  }
  const reserved = await db.auditEvent.findMany({
    where: { action: { in: [
      "research.campaign.spend.reserved",
      "research.campaign.dispatch.intent",
      "research.campaign.provider.returned",
      "research.campaign.spend.settled",
    ] }, metadata: { path: ["campaignId"], equals: campaignId } },
    select: { action: true, entityId: true, metadata: true },
    take: 201,
  });
  if (reserved.length > 200) {
    return { status: 409, code: "RECONCILIATION_AUDIT_TRUNCATED" };
  }
  const entries = [];
  for (const task of tasks) {
    const matching = reserved.filter(event =>
      event.metadata?.campaignId === campaignId &&
      event.metadata?.workspaceId === workspaceId &&
      event.metadata?.taskId === task.id);
    const reservations = matching.filter(event =>
      event.action === "research.campaign.spend.reserved");
    let spend = null;
    if (reservations.length === 1 && reservations[0].entityId) {
      spend = await db.researchSpendReservation.findUnique({
        where: { id: reservations[0].entityId },
        select: { workspaceId: true, ownerId: true, status: true,
          reservedCents: true, chargedCents: true },
      });
      if (!spend || spend.ownerId !== ownerId ||
          spend.workspaceId !== workspaceId) spend = null;
    }
    entries.push({
      taskIndex: task.taskIndex,
      taskStatus: task.status,
      leaseExpired: task.leaseUntil instanceof Date &&
        task.leaseUntil <= clock,
      attempts: task.attempts,
      lastErrorCode: task.lastErrorCode,
      reservationTraceUnique: reservations.length === 1,
      reservationStatus: spend?.status ?? "UNCONFIRMED",
      reservedCents: spend?.reservedCents ?? null,
      conservativeChargedCents: spend?.chargedCents ?? null,
      dispatchIntentRecorded: matching.some(event =>
        event.action === "research.campaign.dispatch.intent"),
      providerReturnedRecorded: matching.some(event =>
        event.action === "research.campaign.provider.returned"),
      automaticReplayAllowed: false,
    });
  }
  return {
    status: 200, code: "DISCOVERY_RECONCILIATION_SNAPSHOT",
    fullRunStatus: full.status, fullRunCode: full.lastCode,
    entries, requiresManualProviderBillingReview: entries.length > 0,
    automaticReplayAllowed: false, mutatesLedger: false,
  };
}
