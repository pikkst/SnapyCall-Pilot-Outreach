// Immutable, separately authorized source-resolution spend envelope.
// This does not dispatch a provider call; the later executor must atomically
// reserve owner budget, enforce this envelope and fence each job lease.
import { createHash } from "node:crypto";
import { isWorkspaceId, lockActiveWorkspaceMembership }
  from "./workspace-access.js";
import { requireResearchPriceEnvelope } from "./research-price-policy.js";

const MAX_CALLS = 250;
const MAX_RUN_CENTS = 50_000;
const APPROVAL_MS = 24 * 60 * 60 * 1000;
const HEX = /^[a-f0-9]{64}$/;

export function personSourceJobSnapshot(jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0 || jobs.length > MAX_CALLS ||
      jobs.some(job => typeof job?.observationId !== "string" ||
        !isWorkspaceId(job.observationId) ||
        typeof job?.evidenceFingerprint !== "string" ||
        !HEX.test(job.evidenceFingerprint) ||
        typeof job?.reason !== "string" || ![
          "SHARED_SOURCE", "ALTERNATE_EMAIL_SOURCE", "PERSON_SOURCE_REQUIRED",
        ].includes(job.reason) || job.status !== "QUEUED")) {
    throw new TypeError("Complete queued source-job snapshot required");
  }
  const sorted = [...jobs].sort((a, b) =>
    a.observationId.localeCompare(b.observationId));
  if (new Set(sorted.map(job => job.observationId)).size !== jobs.length) {
    throw new TypeError("Duplicate source-resolution observation");
  }
  return createHash("sha256").update(JSON.stringify([
    "ai98-person-source-approval-v1",
    ...sorted.map(job => [job.observationId, job.evidenceFingerprint, job.reason]),
  ])).digest("hex");
}

export function validatePersonSourceApproval(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some(key => ![
        "maxCalls", "maxWorstCaseCents", "confirmPaidSourceResearch",
        "confirmNoAutomaticRetry",
      ].includes(key)) ||
      !Number.isInteger(input.maxCalls) || input.maxCalls < 1 ||
      input.maxCalls > MAX_CALLS ||
      !Number.isSafeInteger(input.maxWorstCaseCents) ||
      input.maxWorstCaseCents < 1 ||
      input.maxWorstCaseCents > MAX_RUN_CENTS ||
      input.confirmPaidSourceResearch !== true ||
      input.confirmNoAutomaticRetry !== true) {
    throw new TypeError("Explicit bounded person-source spend approval required");
  }
  return Object.freeze({ maxCalls: input.maxCalls,
    maxWorstCaseCents: input.maxWorstCaseCents });
}

export async function approvePersonSourceResearch(db, {
  campaignId, workspaceId, ownerId, input,
}, { now = () => new Date() } = {}) {
  if (![campaignId, workspaceId, ownerId].every(isWorkspaceId)) {
    throw new TypeError("Owner-scoped campaign required");
  }
  const limits = validatePersonSourceApproval(input);
  const clock = now();
  if (!(clock instanceof Date) || !Number.isFinite(clock.getTime())) {
    throw new TypeError("Valid approval clock required");
  }
  // Read-only model lookup: pricing must be from the same approved registry as
  // discovery, not user-supplied rates or an unverified provider capability.
  const setting = await db.aiSetting.findUnique({
    where: { ownerId }, select: { provider: true, model: true },
  });
  if (!setting) return { status: 409, code: "RESEARCH_AI_SETTINGS_REQUIRED" };
  const price = requireResearchPriceEnvelope(setting);
  if (limits.maxWorstCaseCents < price.worstCaseCents ||
      limits.maxWorstCaseCents > limits.maxCalls * price.worstCaseCents) {
    return { status: 409, code: "SOURCE_RUN_PRICE_ENVELOPE_INVALID" };
  }
  return db.$transaction(async tx => {
    if (!await lockActiveWorkspaceMembership(tx, { workspaceId, userId: ownerId })) {
      return { status: 403, code: "WORKSPACE_ACCESS_REVOKED" };
    }
    const campaigns = await tx.$queryRaw`
      SELECT "id","status" FROM "ResearchCampaign"
      WHERE "id" = ${campaignId} AND "workspaceId" = ${workspaceId}
        AND "ownerId" = ${ownerId} FOR UPDATE`;
    if (campaigns.length !== 1) return { status: 404, code: "CAMPAIGN_NOT_FOUND" };
    const previous = await tx.researchPersonSourceApproval.findUnique({
      where: { campaignId },
    });
    if (previous) {
      return { status: 409, code: "SOURCE_RUN_APPROVAL_IMMUTABLE" };
    }
    if (!["PARTIAL", "COMPLETED"].includes(campaigns[0].status)) {
      return { status: 409, code: "DISCOVERY_NOT_TERMINAL" };
    }
    const jobs = await tx.researchPersonSourceJob.findMany({
      where: { campaignId },
      select: { observationId: true, evidenceFingerprint: true,
        reason: true, status: true },
      orderBy: { observationId: "asc" }, take: MAX_CALLS + 1,
    });
    if (!jobs.length || jobs.length > MAX_CALLS) {
      return { status: 409, code: "SOURCE_JOB_COUNT_INVALID" };
    }
    if (limits.maxCalls > jobs.length) {
      return { status: 409, code: "SOURCE_RUN_CALL_CAP_EXCEEDS_JOBS" };
    }
    let snapshot;
    try { snapshot = personSourceJobSnapshot(jobs); }
    catch { return { status: 409, code: "SOURCE_JOB_SNAPSHOT_REVIEW_REQUIRED" }; }
    // Prior account budget and provider quota are rechecked by the executor
    // at EACH dispatch; approval is intentionally not spend authorization
    // beyond the frozen provider/model/run job set.
    const created = await tx.researchPersonSourceApproval.create({ data: {
      campaignId, workspaceId, ownerId,
      provider: setting.provider, model: setting.model,
      priceVersion: price.priceVersion,
      worstCasePerCallCents: price.worstCaseCents,
      maxCalls: limits.maxCalls, maxWorstCaseCents: limits.maxWorstCaseCents,
      eligibleJobCount: jobs.length, jobSnapshotHash: snapshot,
      expiresAt: new Date(clock.getTime() + APPROVAL_MS),
    } });
    await tx.auditEvent.create({ data: {
      actorId: ownerId, entityId: campaignId,
      action: "research.campaign.person-source-run.approved",
      metadata: { workspaceId, approvalId: created.id,
        provider: setting.provider, model: setting.model,
        priceVersion: price.priceVersion, maxCalls: limits.maxCalls,
        maxWorstCaseCents: limits.maxWorstCaseCents,
        eligibleJobCount: jobs.length, jobSnapshotHash: snapshot,
        automaticBillableReplay: false, sendingEnabled: false },
    } });
    return { status: 201, code: "SOURCE_RUN_APPROVED",
      approval: { id: created.id, status: created.status,
        maxCalls: created.maxCalls,
        maxWorstCaseCents: created.maxWorstCaseCents,
        eligibleJobCount: created.eligibleJobCount,
        expiresAt: created.expiresAt, sendingEnabled: false } };
  });
}
