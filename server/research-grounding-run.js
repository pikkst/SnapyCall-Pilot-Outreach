// Explicit bounded grounding-source authorization and durable one-shot claims.
// No HTTP, provider API, email, Candidate or outreach activity is triggered.
import { randomUUID } from "node:crypto";
import { lockActiveWorkspaceMembership, isWorkspaceId } from "./workspace-access.js";
import { isGoogleGroundingCitation } from "./research-grounding-location.js";

const MAX_SOURCES = 250;
const APPROVAL_MS = 24 * 60 * 60 * 1000;
const LEASE_MS = 60_000;
const validScope = ({ campaignId, workspaceId, ownerId }) =>
  [campaignId, workspaceId, ownerId].every(isWorkspaceId);
const validClock = now => {
  const clock = now();
  if (!(clock instanceof Date) || !Number.isFinite(clock.getTime())) {
    throw new TypeError("Valid clock required");
  }
  return clock;
};

export async function approveGroundingResolution(db, {
  campaignId, workspaceId, ownerId, maxSources, confirmPublicRequests,
}, { now = () => new Date() } = {}) {
  if (!validScope({ campaignId, workspaceId, ownerId }) ||
      !Number.isInteger(maxSources) || maxSources < 1 || maxSources > MAX_SOURCES ||
      confirmPublicRequests !== true) {
    throw new TypeError("Explicit owner-scoped, bounded grounding approval required");
  }
  const clock = validClock(now);
  return db.$transaction(async tx => {
    if (!await lockActiveWorkspaceMembership(tx, { workspaceId, userId: ownerId })) {
      return { status: 403, code: "WORKSPACE_ACCESS_REVOKED" };
    }
    const campaigns = await tx.$queryRaw`
      SELECT "id","status","groundingRunStatus" FROM "ResearchCampaign"
      WHERE "id" = ${campaignId} AND "workspaceId" = ${workspaceId}
        AND "ownerId" = ${ownerId} FOR UPDATE`;
    if (campaigns.length !== 1) return { status: 404, code: "CAMPAIGN_NOT_FOUND" };
    if (campaigns[0].groundingRunStatus !== "IDLE") {
      return { status: 409, code: "GROUNDING_APPROVAL_IMMUTABLE" };
    }
    if (!["COMPLETED", "PARTIAL"].includes(campaigns[0].status)) {
      return { status: 409, code: "DISCOVERY_NOT_TERMINAL" };
    }
    const observations = await tx.researchCampaignObservation.findMany({
      where: { campaignId },
      select: { id: true, citationUrl: true, groundingStatus: true,
        groundingLeaseToken: true },
      take: MAX_SOURCES + 1,
      orderBy: { id: "asc" },
    });
    if (observations.length === 0 || observations.length > maxSources) {
      return { status: 409, code: "GROUNDING_SOURCE_CAP_EXCEEDED",
        availableObservations: observations.length };
    }
    if (observations.some(item => item.groundingStatus !== "UNCHECKED" ||
        item.groundingLeaseToken != null)) {
      return { status: 409, code: "GROUNDING_ALREADY_ATTEMPTED" };
    }
    const resolvable = observations.filter(item =>
      isGoogleGroundingCitation(item.citationUrl)).length;
    if (resolvable !== observations.length) {
      return { status: 409, code: "GROUNDING_CITATION_REQUIRES_REVIEW",
        availableObservations: observations.length, resolvableObservations: resolvable };
    }
    const expiresAt = new Date(clock.getTime() + APPROVAL_MS);
    await tx.researchCampaign.update({
      where: { id: campaignId },
      data: { groundingRunStatus: "RUNNING", groundingRunMaxSources: maxSources,
        groundingRunApprovedAt: clock, groundingRunExpiresAt: expiresAt },
    });
    await tx.auditEvent.create({ data: {
      actorId: ownerId, entityId: campaignId,
      action: "research.campaign.grounding.approved",
      metadata: { workspaceId, maxSources, observed: observations.length,
        expiresAt: expiresAt.toISOString(), providerCalls: 0,
        emailInspectionAuthorized: false, sendingEnabled: false,
        automaticReplayAllowed: false },
    } });
    return { status: 201, code: "GROUNDING_APPROVED", maxSources, expiresAt };
  });
}

export async function claimGroundingObservation(db, scope,
  { now = () => new Date() } = {}) {
  if (!validScope(scope)) throw new TypeError("Owner scope required");
  const clock = validClock(now);
  return db.$transaction(async tx => {
    if (!await lockActiveWorkspaceMembership(tx, {
      workspaceId: scope.workspaceId, userId: scope.ownerId,
    })) return { status: "ACCESS_REVOKED" };
    const campaigns = await tx.$queryRaw`
      SELECT "id","groundingRunStatus","groundingRunMaxSources",
        "groundingRunExpiresAt"
      FROM "ResearchCampaign"
      WHERE "id" = ${scope.campaignId} AND "workspaceId" = ${scope.workspaceId}
        AND "ownerId" = ${scope.ownerId} FOR UPDATE`;
    if (campaigns.length !== 1 || campaigns[0].groundingRunStatus !== "RUNNING") {
      return { status: "NOT_RUNNING" };
    }
    const campaign = campaigns[0];
    if (!(campaign.groundingRunExpiresAt instanceof Date) ||
        campaign.groundingRunExpiresAt <= clock) {
      await tx.researchCampaign.update({
        where: { id: scope.campaignId }, data: { groundingRunStatus: "PAUSED" },
      });
      return { status: "EXPIRED" };
    }
    const inFlight = await tx.researchCampaignObservation.findFirst({
      where: { campaignId: scope.campaignId, groundingLeaseToken: { not: null } },
      select: { groundingLeaseUntil: true },
    });
    if (inFlight) {
      if (!(inFlight.groundingLeaseUntil instanceof Date) ||
          inFlight.groundingLeaseUntil <= clock) {
        await tx.researchCampaign.update({
          where: { id: scope.campaignId }, data: { groundingRunStatus: "PAUSED" },
        });
        return { status: "LEASE_REVIEW_REQUIRED" };
      }
      return { status: "IN_FLIGHT" };
    }
    const attempted = await tx.researchCampaignObservation.count({
      where: { campaignId: scope.campaignId, groundingStatus: { not: "UNCHECKED" } },
    });
    if (attempted >= campaign.groundingRunMaxSources) {
      await tx.researchCampaign.update({
        where: { id: scope.campaignId }, data: { groundingRunStatus: "COMPLETED" },
      });
      return { status: "LIMIT_REACHED" };
    }
    const rows = await tx.$queryRaw`
      SELECT "id","citationUrl" FROM "ResearchCampaignObservation"
      WHERE "campaignId" = ${scope.campaignId}
        AND "groundingStatus" = 'UNCHECKED' AND "groundingLeaseToken" IS NULL
      ORDER BY "id" ASC LIMIT 1 FOR UPDATE SKIP LOCKED`;
    if (rows.length !== 1) {
      await tx.researchCampaign.update({
        where: { id: scope.campaignId }, data: { groundingRunStatus: "COMPLETED" },
      });
      return { status: "COMPLETED" };
    }
    if (!isGoogleGroundingCitation(rows[0].citationUrl)) {
      await tx.researchCampaign.update({
        where: { id: scope.campaignId }, data: { groundingRunStatus: "PAUSED" },
      });
      return { status: "CITATION_DRIFT_REVIEW_REQUIRED" };
    }
    const token = randomUUID();
    const leaseUntil = new Date(clock.getTime() + LEASE_MS);
    const updated = await tx.researchCampaignObservation.updateMany({
      where: { id: rows[0].id, campaignId: scope.campaignId,
        groundingStatus: "UNCHECKED", groundingLeaseToken: null },
      data: { groundingLeaseToken: token, groundingLeaseUntil: leaseUntil },
    });
    if (updated.count !== 1) throw new Error("GROUNDING_CLAIM_CONFLICT");
    return { status: "CLAIMED", ...scope,
      observationId: rows[0].id, citationUrl: rows[0].citationUrl,
      token, leaseUntil };
  });
}

export async function stopGroundingResolution(db, scope) {
  if (!validScope(scope)) throw new TypeError("Owner scope required");
  return db.$transaction(async tx => {
    if (!await lockActiveWorkspaceMembership(tx, {
      workspaceId: scope.workspaceId, userId: scope.ownerId,
    })) return { status: 403, code: "WORKSPACE_ACCESS_REVOKED" };
    const campaigns = await tx.$queryRaw`
      SELECT "id","groundingRunStatus" FROM "ResearchCampaign"
      WHERE "id" = ${scope.campaignId} AND "workspaceId" = ${scope.workspaceId}
        AND "ownerId" = ${scope.ownerId} FOR UPDATE`;
    if (campaigns.length !== 1) return { status: 404, code: "CAMPAIGN_NOT_FOUND" };
    if (campaigns[0].groundingRunStatus !== "RUNNING") {
      return { status: 200, code: "GROUNDING_NOT_RUNNING" };
    }
    await tx.researchCampaign.update({
      where: { id: scope.campaignId }, data: { groundingRunStatus: "PAUSED" },
    });
    await tx.auditEvent.create({ data: {
      actorId: scope.ownerId, entityId: scope.campaignId,
      action: "research.campaign.grounding.stopped",
      metadata: { workspaceId: scope.workspaceId,
        inFlightMayComplete: true, automaticReplayAllowed: false,
        sendingEnabled: false },
    } });
    return { status: 200, code: "GROUNDING_STOPPED" };
  });
}
