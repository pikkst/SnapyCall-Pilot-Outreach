// Materialize research-only person-source work from previously persisted evidence.
// This does not authorize, reserve or dispatch any paid provider operation.
import { createHash } from "node:crypto";
import { isWorkspaceId, lockActiveWorkspaceMembership }
  from "./workspace-access.js";
import { planPersonSourceResolution } from "./research-person-source-plan.js";

const MAX_SOURCES = 250;
const FINGERPRINT_VERSION = "ai98-person-source-job-v1";

export function personSourceFingerprint(row) {
  if (!row || typeof row !== "object") {
    throw new TypeError("Saved observation required");
  }
  return createHash("sha256").update(JSON.stringify([
    FINGERPRINT_VERSION, row.id, row.name, row.category, row.citationUrl,
    row.groundingStatus, row.groundingResolvedUrl,
    row.groundingProvenance, row.emailTriageStatus,
  ])).digest("hex");
}

export async function enqueuePersonSourceJobs(db, {
  campaignId, workspaceId, ownerId, confirmQueuePreparation,
}) {
  if (![campaignId, workspaceId, ownerId].every(isWorkspaceId) ||
      confirmQueuePreparation !== true) {
    throw new TypeError("Owner-scoped queue preparation approval required");
  }
  return db.$transaction(async tx => {
    if (!await lockActiveWorkspaceMembership(tx, {
      workspaceId, userId: ownerId,
    })) return { status: 403, code: "WORKSPACE_ACCESS_REVOKED" };

    // Lock order matches the existing membership -> campaign -> evidence paths.
    const campaigns = await tx.$queryRaw`
      SELECT "id","status" FROM "ResearchCampaign"
      WHERE "id" = ${campaignId} AND "workspaceId" = ${workspaceId}
        AND "ownerId" = ${ownerId} FOR UPDATE`;
    if (campaigns.length !== 1) {
      return { status: 404, code: "CAMPAIGN_NOT_FOUND" };
    }
    if (!["COMPLETED", "PARTIAL"].includes(campaigns[0].status)) {
      return { status: 409, code: "DISCOVERY_NOT_TERMINAL" };
    }
    // Once a stage approval has frozen its job manifest, no further jobs can
    // be appended to that campaign without an explicitly new approval version.
    const approval = await tx.researchPersonSourceApproval.findUnique({
      where: { campaignId }, select: { id: true },
    });
    if (approval) {
      return { status: 409, code: "SOURCE_JOB_MANIFEST_FROZEN" };
    }
    const total = await tx.researchCampaignObservation.count({
      where: { campaignId },
    });
    if (total > MAX_SOURCES) {
      return { status: 409, code: "SOURCE_RESOLUTION_QUEUE_CAP_EXCEEDED" };
    }
    const observations = await tx.researchCampaignObservation.findMany({
      where: { campaignId },
      select: { id: true, name: true, category: true,
        citationUrl: true, groundingStatus: true,
        groundingResolvedUrl: true, groundingProvenance: true,
        emailTriageStatus: true },
      orderBy: { id: "asc" }, take: MAX_SOURCES + 1,
    });
    if (observations.length !== total) {
      return { status: 409, code: "SOURCE_RESOLUTION_SNAPSHOT_CHANGED" };
    }
    const planned = planPersonSourceResolution(observations);
    if (!planned.reliable) {
      return { status: 409, code: "SOURCE_RESOLUTION_SNAPSHOT_UNRELIABLE" };
    }
    const byId = new Map(observations.map(row => [row.id, row]));
    const proposed = planned.jobs.map(job => ({
      campaignId, observationId: job.observationId,
      evidenceFingerprint: personSourceFingerprint(byId.get(job.observationId)),
      reason: job.reason, status: "QUEUED",
    }));
    const existing = await tx.researchPersonSourceJob.findMany({
      where: { campaignId },
      select: { observationId: true, evidenceFingerprint: true },
    });
    const expected = new Map(proposed.map(job =>
      [job.observationId, job.evidenceFingerprint]));
    // Never reuse an old job for changed/reclassified evidence. Reconciliation
    // must be explicit, not an automatic paid retry or silent queue rewrite.
    if (existing.some(job => expected.get(job.observationId) !==
        job.evidenceFingerprint)) {
      return { status: 409, code: "SOURCE_RESOLUTION_JOB_DRIFT" };
    }
    const inserted = proposed.length ? await tx.researchPersonSourceJob.createMany({
      data: proposed, skipDuplicates: true,
    }) : { count: 0 };
    if (inserted.count > 0) {
      await tx.auditEvent.create({ data: {
        actorId: ownerId, entityId: campaignId,
        action: "research.campaign.person-sources.queued",
        metadata: { workspaceId, jobsAdded: inserted.count,
          totalRequested: proposed.length, maxSources: MAX_SOURCES,
          providerCallsAuthorized: false, emailInspectionAuthorized: false,
          contactCreated: false, sendingEnabled: false },
      } });
    }
    return { status: 200, code: inserted.count
      ? "PERSON_SOURCE_JOBS_QUEUED" : "PERSON_SOURCE_JOBS_UNCHANGED",
      jobsAdded: inserted.count, jobsTotal: proposed.length,
      providerCallsAuthorized: false, sendingEnabled: false };
  });
}
