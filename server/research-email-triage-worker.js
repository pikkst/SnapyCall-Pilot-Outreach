// Durable, user-authorized public-page triage. This stage has NO AI calls,
// Candidate mutations or outreach. Every profile is attempted at most once.
import { randomUUID } from "node:crypto";
import { lockActiveWorkspaceMembership } from "./workspace-access.js";
import { inspectCampaignObservationEmail, isDirectPublicProfileUrl } from "./research-observation-email.js";

const CUID = /^c[a-z0-9]{10,40}$/;
const MAX_PAGES = 250;
const APPROVAL_MS = 24 * 60 * 60 * 1000;
const LEASE_MS = 60_000;
const REVIEW = "NAMED_EMAIL_EVIDENCE_REVIEW_REQUIRED";
const NO_EMAIL_CODES = new Set([
  "ADDRESS_AMBIGUOUS_OR_NOT_PUBLISHED",
  "NO_EXPLICIT_NAMED_PROFILE", "EMAIL_NOT_EXPLICITLY_ASSOCIATED",
]);
const SAFE_CODES = new Set([
  REVIEW, ...NO_EMAIL_CODES,
  "DIRECT_PROFILE_SOURCE_REQUIRED", "SHARED_SOURCE_REQUIRES_REVIEW",
  "PROFILE_INSPECTION_UNAVAILABLE", "PROFILE_PROVENANCE_MISMATCH",
  "PROFILE_OR_ADDRESS_UNAVAILABLE", "WORKSPACE_ACCESS_REVOKED",
  "CAMPAIGN_NOT_FOUND", "OBSERVATION_NOT_FOUND",
]);

function validateScope({ campaignId, workspaceId, ownerId }) {
  if (![campaignId, workspaceId, ownerId].every(x =>
      typeof x === "string" && CUID.test(x))) {
    throw new TypeError("Owner-scoped research campaign required");
  }
}

export async function approveEmailTriage(db, {
  campaignId, workspaceId, ownerId, maxPages, confirmPublicInspection,
}, { now = () => new Date() } = {}) {
  validateScope({ campaignId, workspaceId, ownerId });
  if (!Number.isInteger(maxPages) || maxPages < 1 ||
      maxPages > MAX_PAGES || confirmPublicInspection !== true) {
    throw new TypeError("An explicit bounded public-inspection approval is required");
  }
  const clock = now();
  if (!(clock instanceof Date) || !Number.isFinite(clock.getTime())) {
    throw new TypeError("Valid clock required");
  }
  return db.$transaction(async tx => {
    if (!await lockActiveWorkspaceMembership(tx, { workspaceId, userId: ownerId })) {
      return { status: 403, code: "WORKSPACE_ACCESS_REVOKED" };
    }
    const campaigns = await tx.$queryRaw`
      SELECT "id","status","emailTriageStatus","emailTriageMaxPages"
      FROM "ResearchCampaign"
      WHERE "id" = ${campaignId} AND "workspaceId" = ${workspaceId}
        AND "ownerId" = ${ownerId} FOR UPDATE`;
    if (campaigns.length !== 1) return { status: 404, code: "CAMPAIGN_NOT_FOUND" };
    const campaign = campaigns[0];
    if (campaign.emailTriageStatus !== "IDLE") {
      return { status: 409, code: "EMAIL_TRIAGE_APPROVAL_IMMUTABLE" };
    }
    // Scope is intentionally restricted to completed discovery campaigns.
    // Discovery itself cannot create a contact or silently authorize this.
    if (!["COMPLETED", "PARTIAL"].includes(campaign.status)) {
      return { status: 409, code: "DISCOVERY_NOT_TERMINAL" };
    }
    const count = await tx.researchCampaignObservation.count({
      where: { campaignId },
    });
    if (count < 1 || count > maxPages) {
      return { status: 409, code: "EMAIL_TRIAGE_PAGE_CAP_EXCEEDED",
        availableObservations: count };
    }
    // Historical Gemini grounding URLs are not independently inspectable
    // profiles. Reject an all-opaque campaign before persisting approval:
    // otherwise every observation would be marked BLOCKED without a fetch.
    // Preserve the original provider citation and require source resolution
    // or independently supplied direct profiles in a separate reviewed flow.
    const sources = await tx.researchCampaignObservation.findMany({
      where: { campaignId },
      select: { citationUrl: true },
      take: maxPages,
    });
    if (sources.length !== count) {
      return { status: 409, code: "EMAIL_TRIAGE_SOURCE_SNAPSHOT_CHANGED" };
    }
    if (!sources.some(source => isDirectPublicProfileUrl(source.citationUrl))) {
      return { status: 409, code: "EMAIL_TRIAGE_DIRECT_SOURCE_REQUIRED",
        availableObservations: count, inspectableObservations: 0 };
    }
    // Reject reauthorization if any previously claimed page exists.
    const previouslyChecked = await tx.researchCampaignObservation.count({
      where: { campaignId, emailTriageStatus: { not: "UNCHECKED" } },
    });
    if (previouslyChecked) return { status: 409, code: "EMAIL_TRIAGE_ALREADY_ATTEMPTED" };
    const expiresAt = new Date(clock.getTime() + APPROVAL_MS);
    await tx.researchCampaign.update({
      where: { id: campaignId },
      data: { emailTriageStatus: "RUNNING", emailTriageAuthorizedAt: clock,
        emailTriageExpiresAt: expiresAt, emailTriageMaxPages: maxPages },
    });
    await tx.auditEvent.create({ data: {
      actorId: ownerId, entityId: campaignId,
      action: "research.campaign.email-triage.approved",
      metadata: { workspaceId, maxPages, expiresAt: expiresAt.toISOString(),
        providerCallsAuthorized: false, sendingEnabled: false,
        automaticRetryAllowed: false },
    } });
    return { status: 201, code: "EMAIL_TRIAGE_APPROVED",
      maxPages, expiresAt, providerCallsAuthorized: false,
      sendingEnabled: false };
  });
}

export async function stopEmailTriage(db, { campaignId, workspaceId, ownerId }) {
  validateScope({ campaignId, workspaceId, ownerId });
  return db.$transaction(async tx => {
    if (!await lockActiveWorkspaceMembership(tx, { workspaceId, userId: ownerId })) {
      return { status: 403, code: "WORKSPACE_ACCESS_REVOKED" };
    }
    const rows = await tx.$queryRaw`
      SELECT "id","emailTriageStatus" FROM "ResearchCampaign"
      WHERE "id" = ${campaignId} AND "workspaceId" = ${workspaceId}
        AND "ownerId" = ${ownerId} FOR UPDATE`;
    if (rows.length !== 1) return { status: 404, code: "CAMPAIGN_NOT_FOUND" };
    if (rows[0].emailTriageStatus !== "RUNNING") {
      return { status: 200, code: "EMAIL_TRIAGE_NOT_RUNNING" };
    }
    await tx.researchCampaign.update({
      where: { id: campaignId },
      data: { emailTriageStatus: "PAUSED" },
    });
    await tx.auditEvent.create({ data: {
      actorId: ownerId, entityId: campaignId,
      action: "research.campaign.email-triage.stopped",
      metadata: { workspaceId, retryAllowed: false, sendingEnabled: false },
    } });
    return { status: 200, code: "EMAIL_TRIAGE_STOPPED" };
  });
}

export async function claimEmailTriageObservation(db, {
  campaignId, workspaceId, ownerId,
}, { now = () => new Date() } = {}) {
  validateScope({ campaignId, workspaceId, ownerId });
  const clock = now();
  if (!(clock instanceof Date) || !Number.isFinite(clock.getTime())) {
    throw new TypeError("Valid clock required");
  }
  return db.$transaction(async tx => {
    if (!await lockActiveWorkspaceMembership(tx, { workspaceId, userId: ownerId })) {
      return { status: "ACCESS_REVOKED" };
    }
    const campaigns = await tx.$queryRaw`
      SELECT "id","emailTriageStatus","emailTriageExpiresAt","emailTriageMaxPages"
      FROM "ResearchCampaign"
      WHERE "id" = ${campaignId} AND "workspaceId" = ${workspaceId}
        AND "ownerId" = ${ownerId} FOR UPDATE`;
    if (campaigns.length !== 1 || campaigns[0].emailTriageStatus !== "RUNNING") {
      return { status: "NOT_RUNNING" };
    }
    const campaign = campaigns[0];
    if (!(campaign.emailTriageExpiresAt instanceof Date) ||
        campaign.emailTriageExpiresAt <= clock) {
      await tx.researchCampaign.update({
        where: { id: campaignId }, data: { emailTriageStatus: "PAUSED" },
      });
      return { status: "EXPIRED" };
    }
    const active = await tx.researchCampaignObservation.count({
      where: { campaignId, emailTriageStatus: "CHECKING" },
    });
    // An interrupted or slow fetch must never automatically replay.
    if (active > 0) {
      const stale = await tx.researchCampaignObservation.count({
        where: { campaignId, emailTriageStatus: "CHECKING",
          emailTriageLeaseUntil: { lte: clock } },
      });
      if (stale) {
        await tx.researchCampaign.update({
          where: { id: campaignId }, data: { emailTriageStatus: "PAUSED" },
        });
        return { status: "LEASE_REVIEW_REQUIRED" };
      }
      return { status: "IN_FLIGHT" };
    }
    const inspected = await tx.researchCampaignObservation.count({
      where: { campaignId, emailTriageStatus: { not: "UNCHECKED" } },
    });
    if (inspected >= campaign.emailTriageMaxPages) {
      await tx.researchCampaign.update({
        where: { id: campaignId }, data: { emailTriageStatus: "COMPLETED" },
      });
      return { status: "LIMIT_REACHED" };
    }
    const rows = await tx.$queryRaw`
      SELECT "id" FROM "ResearchCampaignObservation"
      WHERE "campaignId" = ${campaignId} AND "emailTriageStatus" = 'UNCHECKED'
      ORDER BY "id" ASC LIMIT 1 FOR UPDATE SKIP LOCKED`;
    if (rows.length !== 1) {
      await tx.researchCampaign.update({
        where: { id: campaignId }, data: { emailTriageStatus: "COMPLETED" },
      });
      return { status: "COMPLETED" };
    }
    const token = randomUUID();
    const until = new Date(clock.getTime() + LEASE_MS);
    const updated = await tx.researchCampaignObservation.updateMany({
      where: { id: rows[0].id, campaignId, emailTriageStatus: "UNCHECKED" },
      data: { emailTriageStatus: "CHECKING",
        emailTriageLeaseToken: token, emailTriageLeaseUntil: until },
    });
    if (updated.count !== 1) throw new Error("EMAIL_TRIAGE_CLAIM_CONFLICT");
    return { status: "CLAIMED", observationId: rows[0].id,
      campaignId, workspaceId, ownerId, token, leaseUntil: until };
  });
}

export async function finishEmailTriageObservation(db, claim, outcome,
  { now = () => new Date() } = {}) {
  validateScope(claim);
  if (claim.status !== "CLAIMED" || typeof claim.token !== "string" ||
      claim.token.length < 10 || !CUID.test(claim.observationId)) {
    throw new TypeError("Valid claimed observation required");
  }
  const clock = now();
  const code = SAFE_CODES.has(outcome?.code) ? outcome.code : "PROFILE_INSPECTION_UNAVAILABLE";
  const hasEvidence = code === REVIEW &&
    typeof outcome?.observedEmail === "string" &&
    /^[a-f0-9]{64}$/.test(outcome?.evidenceDigest ?? "");
  const triageStatus = hasEvidence ? "REVIEW_REQUIRED" :
    NO_EMAIL_CODES.has(code) ? "NO_EMAIL" : "BLOCKED";
  return db.$transaction(async tx => {
    if (!await lockActiveWorkspaceMembership(tx, {
      workspaceId: claim.workspaceId, userId: claim.ownerId,
    })) return { status: "ACCESS_REVOKED" };
    const campaign = await tx.$queryRaw`
      SELECT "id","emailTriageStatus" FROM "ResearchCampaign"
      WHERE "id" = ${claim.campaignId} AND "workspaceId" = ${claim.workspaceId}
        AND "ownerId" = ${claim.ownerId} FOR UPDATE`;
    if (campaign.length !== 1 || campaign[0].emailTriageStatus !== "RUNNING") {
      return { status: "STOPPED_OR_REVOKED" };
    }
    const updated = await tx.researchCampaignObservation.updateMany({
      where: { id: claim.observationId, campaignId: claim.campaignId,
        emailTriageStatus: "CHECKING", emailTriageLeaseToken: claim.token,
        emailTriageLeaseUntil: { gt: clock } },
      data: {
        emailTriageStatus: triageStatus, emailTriageCode: code,
        emailTriageLeaseToken: null, emailTriageLeaseUntil: null,
        emailTriageEmail: hasEvidence ? outcome.observedEmail : null,
        emailTriageDigest: hasEvidence ? outcome.evidenceDigest : null,
        emailTriageAt: clock,
      },
    });
    if (updated.count !== 1) return { status: "LEASE_UNCONFIRMED" };
    await tx.auditEvent.create({ data: {
      actorId: claim.ownerId, entityId: claim.observationId,
      action: "research.campaign.email-triage.inspected",
      metadata: { campaignId: claim.campaignId, workspaceId: claim.workspaceId,
        status: triageStatus, code, emailStored: hasEvidence,
        contactCreated: false, providerCalls: 0, sendingEnabled: false },
    } });
    return { status: triageStatus, code };
  });
}

export function emailTriageSummary(campaign, counts) {
  const by = Object.fromEntries(counts.map(row => [row.emailTriageStatus, row._count.id]));
  return {
    status: campaign.emailTriageStatus,
    maxPages: campaign.emailTriageMaxPages,
    expiresAt: campaign.emailTriageExpiresAt,
    remaining: by.UNCHECKED ?? 0,
    checking: by.CHECKING ?? 0,
    reviewRequired: by.REVIEW_REQUIRED ?? 0,
    noEmail: by.NO_EMAIL ?? 0,
    blocked: by.BLOCKED ?? 0,
    uncertain: by.UNCERTAIN ?? 0,
    contactsCreated: 0,
    providerCalls: 0,
    sendingEnabled: false,
  };
}

export async function tickEmailTriage(db, {
  inspect = inspectCampaignObservationEmail, now = () => new Date(),
} = {}) {
  if (typeof inspect !== "function" || typeof now !== "function") {
    throw new TypeError("Trusted inspection worker required");
  }
  const campaign = await db.researchCampaign.findFirst({
    where: { emailTriageStatus: "RUNNING" },
    orderBy: [{ emailTriageAuthorizedAt: "asc" }, { id: "asc" }],
    select: { id: true, workspaceId: true, ownerId: true },
  });
  if (!campaign) return { status: "IDLE" };
  const scope = { campaignId: campaign.id,
    workspaceId: campaign.workspaceId, ownerId: campaign.ownerId };
  const claim = await claimEmailTriageObservation(db, scope, { now });
  if (claim.status !== "CLAIMED") return claim;
  let outcome;
  try {
    outcome = await inspect(db, { ...scope, observationId: claim.observationId });
  } catch {
    outcome = { code: "PROFILE_INSPECTION_UNAVAILABLE" };
  }
  return finishEmailTriageObservation(db, claim, outcome, { now });
}

export function startEmailTriageWorker(db, { intervalMs = 8000 } = {}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 5000 || intervalMs > 60_000) {
    throw new TypeError("Invalid worker interval");
  }
  let busy = false;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped || busy) return;
    busy = true;
    void tickEmailTriage(db).catch(() => {
      console.warn("[email-triage] Worker stopped this tick without replay");
    }).finally(() => { busy = false; });
  }, intervalMs);
  return () => { stopped = true; clearInterval(timer); };
}
