// An authorized person-source task is a distinct paid research unit.
// Claim, owner-wide budget reservation and quota are one atomic transaction.
// Existing ResearchCampaignTask and Candidate acceptance contracts are untouched.
import { randomUUID } from "node:crypto";
import { isWorkspaceId, lockActiveWorkspaceMembership }
  from "./workspace-access.js";
import { personSourceFingerprint } from "./research-person-source-queue.js";
import { personSourceJobSnapshot } from "./research-person-source-approval.js";
import { requireResearchPriceEnvelope } from "./research-price-policy.js";
import { lockedResearchPreferences, reserveResearchLease,
  reserveResearchAttempt, releaseResearchLease } from "./research-quota.js";
import { reserveOwnerSpend, settleOwnerSpend } from "./research-budget.js";
import { normalizeCampaignObservations } from "./research-campaign-observations.js";
import { isDirectPublicProfileUrl } from "./research-observation-email.js";
import { researchCandidates } from "./ai-research.js";
import { decryptKey } from "./security.js";

const LEASE_MS = 120_000;
const MAX_JOBS = 250;
const sourceFields = {
  id: true, name: true, category: true, citationUrl: true,
  groundingStatus: true, groundingResolvedUrl: true,
  groundingProvenance: true, emailTriageStatus: true,
};
const jobFields = {
  id: true, campaignId: true, observationId: true, status: true,
  evidenceFingerprint: true, reason: true, attempts: true,
  leaseToken: true, leaseUntil: true,
};
export class PersonSourceExecutionBlocked extends Error {
  constructor(code) {
    super("Approved source research is not executable");
    this.name = "PersonSourceExecutionBlocked";
    this.code = code;
  }
}
function validateScope({ campaignId, workspaceId, ownerId }, now) {
  if (![campaignId, workspaceId, ownerId].every(isWorkspaceId) ||
      !(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("Verified person-source campaign and clock required");
  }
}

// This stage uses a frozen manifest of observation fingerprints rather than
// trusting the statuses returned by the browser or cached running task.
export async function claimPersonSourceJob(db, {
  campaignId, workspaceId, ownerId, provider, model,
}, { now = new Date() } = {}) {
  validateScope({ campaignId, workspaceId, ownerId }, now);
  const price = requireResearchPriceEnvelope({ provider, model });
  return db.$transaction(async tx => {
    if (!await lockActiveWorkspaceMembership(tx, { workspaceId, userId: ownerId })) {
      return { status: "BLOCKED", code: "WORKSPACE_ACCESS_REVOKED" };
    }
    const campaigns = await tx.$queryRaw`
      SELECT "id","status" FROM "ResearchCampaign"
      WHERE "id" = ${campaignId} AND "workspaceId" = ${workspaceId}
        AND "ownerId" = ${ownerId} FOR UPDATE`;
    if (campaigns.length !== 1) {
      return { status: "BLOCKED", code: "CAMPAIGN_NOT_FOUND" };
    }
    if (!["PARTIAL", "COMPLETED"].includes(campaigns[0].status)) {
      return { status: "BLOCKED", code: "DISCOVERY_NOT_TERMINAL" };
    }
    const approval = await tx.researchPersonSourceApproval.findUnique({
      where: { campaignId },
    });
    if (!approval || approval.workspaceId !== workspaceId ||
        approval.ownerId !== ownerId ||
        !["APPROVED", "RUNNING"].includes(approval.status)) {
      return { status: "BLOCKED", code: "PERSON_SOURCE_APPROVAL_REQUIRED" };
    }
    if (!(approval.expiresAt instanceof Date) || approval.expiresAt <= now) {
      return { status: "BLOCKED", code: "PERSON_SOURCE_APPROVAL_EXPIRED" };
    }
    if (approval.provider !== provider || approval.model !== model ||
        approval.priceVersion !== price.priceVersion ||
        approval.worstCasePerCallCents !== price.worstCaseCents) {
      return { status: "BLOCKED", code: "PERSON_SOURCE_PRICE_CHANGED" };
    }
    const jobs = await tx.researchPersonSourceJob.findMany({
      where: { campaignId }, select: jobFields,
      orderBy: { observationId: "asc" }, take: MAX_JOBS + 1,
    });
    if (jobs.length !== approval.eligibleJobCount || jobs.length > MAX_JOBS) {
      return { status: "BLOCKED", code: "SOURCE_JOB_SNAPSHOT_CHANGED" };
    }
    let digest;
    try { digest = personSourceJobSnapshot(jobs.map(job =>
      ({ ...job, status: "QUEUED" }))); }
    catch { return { status: "BLOCKED", code: "SOURCE_JOB_SNAPSHOT_CHANGED" }; }
    if (digest !== approval.jobSnapshotHash) {
      return { status: "BLOCKED", code: "SOURCE_JOB_SNAPSHOT_CHANGED" };
    }
    // Never dispatch a new call before a previous possibly billed call has
    // finished and been reconciled. Expired leases are NOT auto-retried.
    if (jobs.some(job => ["RUNNING", "PAUSED"].includes(job.status))) {
      return { status: "BLOCKED", code: "SOURCE_JOB_UNSETTLED" };
    }
    if (approval.startedCalls >= approval.maxCalls ||
        approval.committedWorstCaseCents + price.worstCaseCents >
          approval.maxWorstCaseCents) {
      return { status: "BLOCKED", code: "SOURCE_APPROVED_SPEND_EXHAUSTED" };
    }
    const queued = jobs.find(job => job.status === "QUEUED" && job.attempts === 0);
    if (!queued) return { status: "IDLE", code: "NO_SOURCE_JOB_READY" };
    const observation = await tx.researchCampaignObservation.findFirst({
      where: { campaignId, id: queued.observationId },
      select: sourceFields,
    });
    if (!observation || personSourceFingerprint(observation) !==
        queued.evidenceFingerprint) {
      return { status: "BLOCKED", code: "SOURCE_JOB_EVIDENCE_CHANGED" };
    }
    if (typeof observation.name !== "string" ||
        observation.name.length < 5 || observation.name.length > 160 ||
        /[\r\n]/.test(observation.name) ||
        !["AI_AUTOMATION", "COACHING", "MARKETING_GROWTH",
          "BUSINESS_STRATEGY"].includes(observation.category)) {
      return { status: "BLOCKED", code: "SOURCE_JOB_IDENTITY_INVALID" };
    }
    const preferences = await lockedResearchPreferences(tx, ownerId);
    const leaseId = await reserveResearchLease(tx, {
      workspaceId, userId: ownerId, maxConcurrent: preferences.maxConcurrent,
    });
    const reservationId = randomUUID();
    await reserveOwnerSpend(tx, {
      ownerId, workspaceId, reservationId,
      worstCaseCents: price.worstCaseCents, now,
    });
    await reserveResearchAttempt(tx, {
      workspaceId, userId: ownerId,
      dailyLimit: preferences.dailyLimit, now,
    });
    const updated = await tx.researchPersonSourceApproval.updateMany({
      where: { id: approval.id, campaignId, workspaceId, ownerId,
        status: { in: ["APPROVED", "RUNNING"] }, expiresAt: { gt: now },
        startedCalls: { lt: approval.maxCalls },
        committedWorstCaseCents: { lte:
          approval.maxWorstCaseCents - price.worstCaseCents } },
      data: { status: "RUNNING", startedCalls: { increment: 1 },
        committedWorstCaseCents: { increment: price.worstCaseCents } },
    });
    if (updated.count !== 1) {
      throw new PersonSourceExecutionBlocked("SOURCE_APPROVAL_CONFLICT");
    }
    const leaseToken = randomUUID();
    const leaseUntil = new Date(now.getTime() + LEASE_MS);
    const claimed = await tx.researchPersonSourceJob.updateMany({
      where: { id: queued.id, campaignId, observationId: queued.observationId,
        status: "QUEUED", attempts: 0, leaseToken: null,
        evidenceFingerprint: queued.evidenceFingerprint },
      data: { status: "RUNNING", attempts: { increment: 1 },
        leaseToken, leaseUntil, spendReservationId: reservationId,
        researchLeaseId: leaseId },
    });
    if (claimed.count !== 1) {
      throw new PersonSourceExecutionBlocked("SOURCE_JOB_CLAIM_CONFLICT");
    }
    await tx.auditEvent.create({ data: {
      actorId: ownerId, entityId: queued.id,
      action: "research.person-source.spend.reserved",
      metadata: { workspaceId, campaignId, provider, model,
        priceVersion: price.priceVersion, worstCaseCents: price.worstCaseCents,
        reservationId, automaticBillableReplay: false,
        contactCreated: false, sendingEnabled: false },
    } });
    return {
      status: "CLAIMED", jobId: queued.id, observationId: queued.observationId,
      campaignId, workspaceId, ownerId, name: observation.name,
      category: observation.category, provider, model,
      leaseToken, leaseUntil, leaseId, reservationId,
      worstCaseCents: price.worstCaseCents,
      query: '"' + observation.name + '" ' + observation.category +
        " public professional profile email contact",
    };
  });
}

// Candidate matching is a conservative provider-CITATION hint only, not
// independent identity, address, mailbox or legal-basis verification.
export function proposedPersonSource(preview, { name, category }) {
  if (typeof name !== "string" || typeof category !== "string") {
    throw new TypeError("Expected named person");
  }
  const entries = normalizeCampaignObservations(preview, 5);
  const normalizeName = value => value.normalize("NFKC")
    .replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
  const exact = entries.filter(entry =>
    normalizeName(entry.name) === normalizeName(name) &&
    entry.category === category &&
    isDirectPublicProfileUrl(entry.citationUrl));
  const urls = [...new Set(exact.map(entry => entry.citationUrl))];
  return urls.length === 1 ? urls[0] : null;
}

// Finish is a single fenced DB transaction, including conservative ledger
// settlement. If the fence expired after dispatch, only explicit
// reconciliation may decide next steps; never replay the paid provider.
export async function finishPersonSourceJob(db, claim, {
  proposedUrl = null, providerInvoked = true, code = null,
}, { now = new Date() } = {}) {
  validateScope(claim, now);
  if (!isWorkspaceId(claim.jobId) ||
      typeof claim.leaseToken !== "string" ||
      typeof claim.reservationId !== "string" ||
      typeof providerInvoked !== "boolean" ||
      (proposedUrl !== null && !isDirectPublicProfileUrl(proposedUrl))) {
    throw new TypeError("Valid fenced source-job completion required");
  }
  const result = await db.$transaction(async tx => {
    const authorized = await lockActiveWorkspaceMembership(tx, {
      workspaceId: claim.workspaceId, userId: claim.ownerId,
    });
    const campaigns = await tx.$queryRaw`
      SELECT "id" FROM "ResearchCampaign"
      WHERE "id" = ${claim.campaignId}
        AND "workspaceId" = ${claim.workspaceId}
        AND "ownerId" = ${claim.ownerId} FOR UPDATE`;
    if (campaigns.length !== 1) {
      return { status: "RECONCILIATION_REQUIRED", code: "CAMPAIGN_NOT_FOUND" };
    }
    const job = await tx.researchPersonSourceJob.findFirst({
      where: { id: claim.jobId, campaignId: claim.campaignId,
        observationId: claim.observationId },
    });
    if (!job || job.status !== "RUNNING" ||
        job.leaseToken !== claim.leaseToken ||
        job.spendReservationId !== claim.reservationId ||
        !(job.leaseUntil instanceof Date) || job.leaseUntil <= now) {
      return { status: "RECONCILIATION_REQUIRED", code: "SOURCE_JOB_LEASE_EXPIRED" };
    }
    // Source attribution is not assumed from a provider-cited hit. Check
    // collisions with every already-observed profile before staging a hint.
    let source = proposedUrl;
    if (source) {
      const collisions = await tx.researchCampaignObservation.count({
        where: { campaignId: claim.campaignId,
          id: { not: claim.observationId },
          OR: [{ citationUrl: source }, { groundingResolvedUrl: source }] },
      });
      const otherProposals = await tx.researchPersonSourceJob.count({
        where: { campaignId: claim.campaignId, id: { not: claim.jobId },
          proposedSourceUrl: source },
      });
      if (collisions || otherProposals) source = null;
    }
    const state = authorized
      ? providerInvoked ? "COMPLETED" : "PAUSED" : "PAUSED";
    const reason = !authorized ? "WORKSPACE_ACCESS_REVOKED" :
      !providerInvoked ? "PROVIDER_NOT_DISPATCHED" :
      code === "BILLING_UNCERTAIN" ? "BILLING_UNCERTAIN" :
      source ? "SOURCE_CITATION_NEEDS_INSPECTION" : "NO_UNIQUE_DIRECT_SOURCE";
    await settleOwnerSpend(tx, {
      ownerId: claim.ownerId, workspaceId: claim.workspaceId,
      reservationId: claim.reservationId,
      // No certified per-source cost receipt exists; settle the complete
      // pre-approved worst-case amount for any potentially billed call.
      actualCents: providerInvoked ? null : 0,
    });
    const changed = await tx.researchPersonSourceJob.updateMany({
      where: { id: claim.jobId, campaignId: claim.campaignId,
        status: "RUNNING", leaseToken: claim.leaseToken,
        leaseUntil: { gt: now }, spendReservationId: claim.reservationId },
      data: { status: state, lastErrorCode: reason,
        proposedSourceUrl: authorized ? source : null,
        leaseToken: null, leaseUntil: null },
    });
    if (changed.count !== 1) {
      throw new PersonSourceExecutionBlocked("SOURCE_JOB_COMMIT_CONFLICT");
    }
    await tx.auditEvent.create({ data: {
      actorId: claim.ownerId, entityId: claim.jobId,
      action: "research.person-source.attempt.settled",
      metadata: { workspaceId: claim.workspaceId, campaignId: claim.campaignId,
        status: state, code: reason, providerInvoked,
        conservativeCharge: providerInvoked, automaticBillableReplay: false,
        contactCreated: false, sendingEnabled: false },
    } });
    return { status: state, code: reason, sourceProposed: !!source,
      sendingEnabled: false };
  });
  if (result.status !== "RECONCILIATION_REQUIRED") {
    // Concurrency release is idempotent; a failure leaves the finite TTL lease.
    try {
      await releaseResearchLease(db, claim.leaseId,
        claim.workspaceId, claim.ownerId);
    } catch {
      return { status: "RECONCILIATION_REQUIRED",
        code: "SOURCE_CONCURRENCY_RELEASE_UNCONFIRMED" };
    }
  }
  return result;
}

// This executor performs one authorized provider search. It NEVER silently
// retries, accepts a Candidate, sends a message, or promotes a citation into
// person-specific proof without independent page inspection.
export async function runOnePersonSourceJob(db, {
  campaignId, workspaceId, ownerId, encryptionKey,
}, {
  now = () => new Date(), search = researchCandidates,
  decrypt = decryptKey,
} = {}) {
  if (typeof encryptionKey !== "string" || encryptionKey.length < 16 ||
      typeof search !== "function" || typeof decrypt !== "function") {
    throw new TypeError("Trusted source worker configuration required");
  }
  const setting = await db.aiSetting.findUnique({ where: { ownerId } });
  if (!setting?.provider || !setting.model) {
    return { status: "BLOCKED", code: "RESEARCH_AI_SETTINGS_REQUIRED" };
  }
  // No paid search is allowed until the owner has a matching immutable
  // source-stage approval. Claim transaction rechecks model and pricing.
  const claim = await claimPersonSourceJob(db, {
    campaignId, workspaceId, ownerId,
    provider: setting.provider, model: setting.model,
  }, { now: now() });
  if (claim.status !== "CLAIMED") return claim;
  let invoked = false;
  let result = null;
  try {
    const live = await db.partnerMembership.findUnique({
      where: { partnerId_userId: { partnerId: workspaceId, userId: ownerId } },
      select: { revokedAt: true, user: { select: { googleSub: true } } },
    });
    if (!live || live.revokedAt || !live.user?.googleSub ||
        now() >= claim.leaseUntil) {
      return await finishPersonSourceJob(db, claim,
        { providerInvoked: false }, { now: now() });
    }
    const key = decrypt(setting.encryptedApiKey, encryptionKey);
    if (typeof key !== "string" || key.length < 8) {
      return await finishPersonSourceJob(db, claim,
        { providerInvoked: false }, { now: now() });
    }
    invoked = true;
    result = await search({
      query: claim.query, limit: 5, provider: claim.provider,
      model: claim.model, apiKey: key,
    });
    const source = proposedPersonSource(result, claim);
    return await finishPersonSourceJob(db, claim,
      { proposedUrl: source, providerInvoked: true }, { now: now() });
  } catch {
    // Post-dispatch errors are potentially billable. Conserve the full
    // budget and block future calls until explicit operator reconciliation.
    try {
      return await finishPersonSourceJob(db, claim, {
        proposedUrl: null, providerInvoked: invoked,
        code: invoked ? "BILLING_UNCERTAIN" : "PROVIDER_NOT_DISPATCHED",
      }, { now: now() });
    } catch {
      return { status: "RECONCILIATION_REQUIRED",
        code: "SOURCE_JOB_COST_OR_LEASE_UNCERTAIN" };
    }
  }
}
