// Trusted, read-only RD-01 snapshot loader. Authorization and snapshot
// consistency are established here before the pure funnel reducer runs.
import { requireWorkspaceMembership } from "./workspace-access.js";

const ID = /^c[a-z0-9]{10,40}$/;
const MAX_OBSERVATIONS = 250;
const MAX_AUDITS = 5000;
const AUDIT_ACTIONS = [
  "research.person-source.attempt.settled",
  "research.full-run.stage.changed",
  "research.full-run.zero-yield.stopped",
  "research.full-run.qualified-target.reached",
  "research.qualified-batch.item.processed",
];

function requireId(value, label) {
  if (!ID.test(value ?? "")) throw new TypeError(`Valid ${label} required`);
}

function auditKey(event) {
  if (typeof event.id === "string") return `id:${event.id}`;
  return `fallback:${event.action}:${event.entityId ?? ""}:${JSON.stringify(event.metadata ?? null)}`;
}

function relevantAudits(rows, scope) {
  const seen = new Set();
  return rows.filter(event => {
    const metadata = event?.metadata;
    if (metadata?.workspaceId !== scope.workspaceId ||
        metadata?.campaignId !== scope.campaignId) return false;
    const key = auditKey(event);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function loadResearchFunnelSnapshot(db, {
  campaignId, workspaceId, ownerId,
} = {}) {
  requireId(campaignId, "campaignId");
  requireId(workspaceId, "workspaceId");
  requireId(ownerId, "ownerId");
  if (!db || typeof db.$transaction !== "function") {
    throw new TypeError("Database client required");
  }

  return db.$transaction(async tx => {
    // Repeatable-read + read-only gives counts and rows one PostgreSQL
    // snapshot. No database write is permitted in this transaction.
    await tx.$executeRaw`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    // The read-only path deliberately uses the existing non-locking
    // membership contract. Write workflows retain FOR UPDATE fencing; a
    // repeatable-read diagnostic observes one consistent point-in-time view.
    if (!await requireWorkspaceMembership(tx, { workspaceId, userId: ownerId })) {
      return Object.freeze({ complete: false, code: "WORKSPACE_ACCESS_REVOKED" });
    }

    const campaign = await tx.researchCampaign.findFirst({
      where: { id: campaignId, workspaceId, ownerId },
      select: { id: true, workspaceId: true, ownerId: true, status: true,
        targetCount: true, createdAt: true, updatedAt: true },
    });
    if (!campaign) return Object.freeze({ complete: false, code: "CAMPAIGN_NOT_FOUND" });

    const observationsTotal = await tx.researchCampaignObservation.count({
      where: { campaignId, campaign: { workspaceId, ownerId } },
    });
    const observations = await tx.researchCampaignObservation.findMany({
      where: { campaignId, campaign: { workspaceId, ownerId } },
      orderBy: [{ observedAt: "asc" }, { id: "asc" }],
      take: MAX_OBSERVATIONS + 1,
      select: { id: true, campaignId: true, taskId: true, name: true,
        category: true, citationUrl: true, status: true,
        groundingStatus: true, groundingResolvedUrl: true,
        groundingProvenance: true, emailTriageStatus: true,
        emailTriageCode: true, emailTriageEmail: true,
        emailTriageDigest: true, emailTriageAt: true,
        personSourceUrl: true, personSourceProvenance: true,
        personSourceVerifiedAt: true, candidateId: true },
    });
    const complete = observationsTotal <= MAX_OBSERVATIONS &&
      observations.length === observationsTotal;

    const tasks = await tx.researchCampaignTask.findMany({
      where: { campaignId, campaign: { workspaceId, ownerId } },
      orderBy: [{ taskIndex: "asc" }, { id: "asc" }],
      select: { id: true, taskIndex: true, status: true, attempts: true,
        resultLimit: true, observedCount: true, lastErrorCode: true },
    });
    const sourceJobs = await tx.researchPersonSourceJob.findMany({
      where: { campaignId, campaign: { workspaceId, ownerId } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, observationId: true, status: true, attempts: true,
        proposedSourceUrl: true, lastErrorCode: true, spendReservationId: true },
    });
    const reservationIds = [...new Set(sourceJobs.map(row => row.spendReservationId).filter(Boolean))];
    const spendReservations = reservationIds.length ? await tx.researchSpendReservation.findMany({
      where: { id: { in: reservationIds }, ownerId, workspaceId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, chargedCents: true, status: true, reservedCents: true },
    }) : [];
    const reservationIdSet = new Set(spendReservations.map(row => row.id));
    const missingReservationCount = reservationIds.filter(id => !reservationIdSet.has(id)).length;
    const auditWhere = { action: { in: AUDIT_ACTIONS }, AND: [
      { metadata: { path: ["campaignId"], equals: campaignId } },
      { metadata: { path: ["workspaceId"], equals: workspaceId } },
    ] };
    const auditTotal = await tx.auditEvent.count({ where: auditWhere });
    const [discoveryRun, fullRun, batch, auditRows] = await Promise.all([
      tx.researchCampaignRun.findUnique({ where: { campaignId }, select: {
        startedTasks: true, status: true, maxTasks: true,
      } }),
      tx.researchFullRun.findUnique({ where: { campaignId }, select: {
        status: true, targetQualifiedContacts: true, maxDiscoveryCalls: true,
        maxSourceCalls: true,
      } }),
      tx.researchContactBatch.findUnique({ where: { campaignId }, select: {
        id: true, status: true, itemCount: true,
        items: { orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { id: true, status: true, resultCode: true, candidateId: true } },
      } }),
      tx.auditEvent.findMany({ where: auditWhere,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: MAX_AUDITS,
        select: { id: true, action: true, entityId: true, metadata: true, createdAt: true } }),
    ]);
    const audits = relevantAudits(auditRows, { campaignId, workspaceId });
    return Object.freeze({
      scope: { campaignId, workspaceId, ownerId },
      campaign, discoveryRun, fullRun,
      tasks, observations, sourceJobs, audits,
      acceptedContacts: batch?.items ?? [],
      spendReservations,
      reservationCompleteness: { complete: missingReservationCount === 0,
        requested: reservationIds.length, returned: spendReservations.length,
        missing: missingReservationCount },
      auditCompleteness: { complete: auditTotal <= MAX_AUDITS &&
        auditRows.length === auditTotal, total: auditTotal,
        returned: auditRows.length },
      completeness: { complete, totalObservations: observationsTotal,
        returnedObservations: observations.length },
      readOnly: true,
    });
  }, { isolationLevel: "RepeatableRead" });
}
