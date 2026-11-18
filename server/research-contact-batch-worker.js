// Durable, single-review action for up to 100 independently attributable
// emails. Reuses the existing fresh-evidence Candidate intake per person.
// A batch never authorizes outreach, consent or automatic email sending.
import { randomUUID } from "node:crypto";
import { lockActiveWorkspaceMembership }
  from "./workspace-access.js";
import { acceptReviewedCampaignContact }
  from "./research-observation-contact-intake.js";

const LEASE_MS = 90_000;
const TERMINAL = new Set(["SAVED", "REVIEW_REQUIRED"]);

export async function claimContactBatchItem(db, scope, {
  now = new Date(),
} = {}) {
  return db.$transaction(async tx => {
    if (!await lockActiveWorkspaceMembership(tx, {
      workspaceId: scope.workspaceId, userId: scope.ownerId,
    })) return { status: "BLOCKED", code: "WORKSPACE_ACCESS_REVOKED" };
    const campaigns = await tx.$queryRaw`
      SELECT "id" FROM "ResearchCampaign"
      WHERE "id" = ${scope.campaignId}
        AND "workspaceId" = ${scope.workspaceId}
        AND "ownerId" = ${scope.ownerId}
        AND "status" IN ('PARTIAL', 'COMPLETED') FOR UPDATE`;
    if (campaigns.length !== 1) {
      return { status: "BLOCKED", code: "CAMPAIGN_NOT_FOUND" };
    }
    const batch = await tx.researchContactBatch.findUnique({
      where: { id: scope.batchId },
    });
    if (!batch || batch.campaignId !== scope.campaignId ||
        batch.workspaceId !== scope.workspaceId ||
        batch.ownerId !== scope.ownerId ||
        !["APPROVED", "RUNNING"].includes(batch.status)) {
      return { status: "BLOCKED", code: "CONTACT_BATCH_INACTIVE" };
    }
    const unresolved = await tx.researchContactBatchItem.count({
      where: { batchId: batch.id, status: { in: ["RUNNING", "PAUSED"] } },
    });
    if (unresolved) {
      return { status: "BLOCKED", code: "CONTACT_BATCH_RECONCILIATION_REQUIRED" };
    }
    const item = await tx.researchContactBatchItem.findFirst({
      where: { batchId: batch.id, status: "QUEUED", attempts: 0 },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    if (!item) return { status: "IDLE", code: "NO_REVIEWED_CONTACT_PENDING" };
    const token = randomUUID();
    const leaseUntil = new Date(now.getTime() + LEASE_MS);
    const claimed = await tx.researchContactBatchItem.updateMany({
      where: { id: item.id, batchId: batch.id,
        status: "QUEUED", attempts: 0, leaseToken: null },
      data: { status: "RUNNING", attempts: { increment: 1 },
        leaseToken: token, leaseUntil },
    });
    if (claimed.count !== 1) {
      throw new Error("CONTACT_BATCH_CLAIM_CONFLICT");
    }
    await tx.researchContactBatch.updateMany({
      where: { id: batch.id, status: "APPROVED" },
      data: { status: "RUNNING" },
    });
    return { status: "CLAIMED", ...scope, itemId: item.id,
      observationId: item.observationId,
      expectedDigest: item.expectedDigest, token, leaseUntil };
  });
}

export async function finishContactBatchItem(db, claim, outcome, {
  now = new Date(),
} = {}) {
  if (!claim || !outcome || !(now instanceof Date)) {
    throw new TypeError("Fenced batch completion required");
  }
  return db.$transaction(async tx => {
    if (!await lockActiveWorkspaceMembership(tx, {
      workspaceId: claim.workspaceId, userId: claim.ownerId,
    })) return { status: "RECONCILIATION_REQUIRED",
      code: "WORKSPACE_ACCESS_REVOKED" };
    const campaigns = await tx.$queryRaw`
      SELECT "id" FROM "ResearchCampaign"
      WHERE "id" = ${claim.campaignId}
        AND "workspaceId" = ${claim.workspaceId}
        AND "ownerId" = ${claim.ownerId} FOR UPDATE`;
    if (campaigns.length !== 1) {
      return { status: "RECONCILIATION_REQUIRED", code: "CAMPAIGN_NOT_FOUND" };
    }
    const saved = typeof outcome.candidateId === "string" &&
      /^c[a-z0-9]{10,40}$/.test(outcome.candidateId) &&
      ((outcome.status === 201 &&
        outcome.code === "CONTACT_CREATED_REVIEW_PENDING") ||
       (outcome.status === 200 &&
        outcome.code === "CONTACT_ALREADY_LINKED"));
    const state = saved ? "SAVED" :
      outcome.status === 409 ? "REVIEW_REQUIRED" : "PAUSED";
    const code = saved ? "CONTACT_SAVED_REVIEW_PENDING" :
      outcome.status === 409 ? "PERSON_EMAIL_EVIDENCE_NEEDS_REVIEW" :
      "CONTACT_ACCEPTANCE_UNCERTAIN";
    const changed = await tx.researchContactBatchItem.updateMany({
      where: { id: claim.itemId, batchId: claim.batchId,
        status: "RUNNING", leaseToken: claim.token,
        leaseUntil: { gt: now }, expectedDigest: claim.expectedDigest },
      data: { status: state, resultCode: code,
        candidateId: saved ? outcome.candidateId : null,
        leaseToken: null, leaseUntil: null },
    });
    if (changed.count !== 1) {
      return { status: "RECONCILIATION_REQUIRED",
        code: "CONTACT_BATCH_LEASE_UNCONFIRMED" };
    }
    await tx.auditEvent.create({ data: {
      actorId: claim.ownerId, entityId: claim.itemId,
      action: "research.qualified-batch.item.processed",
      metadata: { workspaceId: claim.workspaceId,
        campaignId: claim.campaignId, batchId: claim.batchId,
        status: state, code, userConfirmedManifest: true,
        sendEligible: false, sendingEnabled: false },
    } });
    return { status: state, code, sendingEnabled: false };
  });
}

export async function reconcileExpiredContactBatchItem(db, scope, {
  now = new Date(),
} = {}) {
  // No external fetch; a crash after successful Candidate creation can be
  // reconciled from the exact CandidateEvidence digest and owner-scoped link.
  return db.$transaction(async tx => {
    if (!await lockActiveWorkspaceMembership(tx, {
      workspaceId: scope.workspaceId, userId: scope.ownerId,
    })) return { status: "BLOCKED", code: "WORKSPACE_ACCESS_REVOKED" };
    const campaigns = await tx.$queryRaw`
      SELECT "id" FROM "ResearchCampaign"
      WHERE "id" = ${scope.campaignId}
        AND "workspaceId" = ${scope.workspaceId}
        AND "ownerId" = ${scope.ownerId} FOR UPDATE`;
    if (campaigns.length !== 1) return { status: "BLOCKED", code: "CAMPAIGN_NOT_FOUND" };
    const item = await tx.researchContactBatchItem.findFirst({
      where: { batchId: scope.batchId, status: "RUNNING",
        leaseUntil: { lte: now } },
      orderBy: { createdAt: "asc" },
    });
    if (!item) return { status: "IDLE", code: "NO_STALE_ITEM" };
    const observation = await tx.researchCampaignObservation.findFirst({
      where: { id: item.observationId, campaignId: scope.campaignId },
      select: { candidateId: true },
    });
    let proven = null;
    if (observation?.candidateId) {
      proven = await tx.candidateDirectEmailObservation.findFirst({
        where: { candidateId: observation.candidateId,
          workspaceId: scope.workspaceId,
          status: "PERSON_EMAIL_REVIEWED",
          evidenceDigest: item.expectedDigest },
        select: { candidateId: true },
      });
    }
    const updated = await tx.researchContactBatchItem.updateMany({
      where: { id: item.id, batchId: scope.batchId, status: "RUNNING",
        leaseUntil: { lte: now }, expectedDigest: item.expectedDigest },
      data: { status: proven ? "SAVED" : "PAUSED",
        candidateId: proven?.candidateId ?? null,
        resultCode: proven ? "CONTACT_ALREADY_LINKED" :
          "CONTACT_BATCH_RECONCILIATION_REQUIRED",
        leaseToken: null, leaseUntil: null },
    });
    if (updated.count !== 1) {
      return { status: "BLOCKED", code: "CONTACT_BATCH_CAS_CONFLICT" };
    }
    await tx.auditEvent.create({ data: {
      actorId: scope.ownerId, entityId: item.id,
      action: "research.qualified-batch.item.reconciled",
      metadata: { workspaceId: scope.workspaceId,
        restoredFromVerifiedLink: !!proven, sendEligible: false,
        automaticRetry: false },
    } });
    return { status: proven ? "SAVED" : "PAUSED",
      code: proven ? "CONTACT_ALREADY_LINKED" :
        "CONTACT_BATCH_RECONCILIATION_REQUIRED" };
  });
}

export async function finalizeContactBatch(db, scope) {
  return db.$transaction(async tx => {
    if (!await lockActiveWorkspaceMembership(tx, {
      workspaceId: scope.workspaceId, userId: scope.ownerId,
    })) return { status: "BLOCKED", code: "WORKSPACE_ACCESS_REVOKED" };
    const campaigns = await tx.$queryRaw`
      SELECT "id" FROM "ResearchCampaign"
      WHERE "id" = ${scope.campaignId}
        AND "workspaceId" = ${scope.workspaceId}
        AND "ownerId" = ${scope.ownerId} FOR UPDATE`;
    if (campaigns.length !== 1) return { status: "BLOCKED", code: "CAMPAIGN_NOT_FOUND" };
    const batch = await tx.researchContactBatch.findUnique({
      where: { id: scope.batchId },
    });
    if (!batch || batch.workspaceId !== scope.workspaceId ||
        batch.ownerId !== scope.ownerId ||
        batch.campaignId !== scope.campaignId ||
        !["APPROVED", "RUNNING"].includes(batch.status)) {
      return { status: "BLOCKED", code: "CONTACT_BATCH_INACTIVE" };
    }
    const rows = await tx.researchContactBatchItem.findMany({
      where: { batchId: batch.id },
      select: { status: true }, take: 101,
    });
    if (rows.length !== batch.itemCount || rows.length > 100) {
      return { status: "BLOCKED", code: "CONTACT_BATCH_SNAPSHOT_CHANGED" };
    }
    if (rows.some(row => !TERMINAL.has(row.status))) {
      return { status: "WAITING", code: "CONTACT_BATCH_WORK_PENDING" };
    }
    const saved = rows.filter(row => row.status === "SAVED").length;
    const terminal = saved === rows.length ? "COMPLETED" : "PARTIAL_REVIEW";
    await tx.researchContactBatch.updateMany({
      where: { id: batch.id, status: { in: ["APPROVED", "RUNNING"] } },
      data: { status: terminal },
    });
    await tx.auditEvent.create({ data: {
      actorId: scope.ownerId, entityId: batch.id,
      action: "research.qualified-batch.finalized",
      metadata: { workspaceId: scope.workspaceId, campaignId: scope.campaignId,
        status: terminal, saved, unresolved: rows.length - saved,
        autoSend: false, sendingEnabled: false },
    } });
    return { status: terminal, saved, unresolved: rows.length - saved };
  });
}

export async function tickContactBatch(db, {
  accept = acceptReviewedCampaignContact,
  now = () => new Date(),
} = {}) {
  if (typeof accept !== "function" || typeof now !== "function") {
    throw new TypeError("Trusted contact intake worker required");
  }
  const batch = await db.researchContactBatch.findFirst({
    where: { status: { in: ["APPROVED", "RUNNING"] } },
    select: { id: true, campaignId: true, workspaceId: true, ownerId: true },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
  });
  if (!batch) return { status: "IDLE" };
  const scope = { campaignId: batch.campaignId,
    workspaceId: batch.workspaceId, ownerId: batch.ownerId,
    batchId: batch.id };
  const recovered = await reconcileExpiredContactBatchItem(db, scope, {
    now: now(),
  });
  if (recovered.status !== "IDLE") return recovered;
  const claim = await claimContactBatchItem(db, scope, { now: now() });
  if (claim.status === "IDLE") return finalizeContactBatch(db, scope);
  if (claim.status !== "CLAIMED") return claim;
  let result;
  try {
    result = await accept(db, {
      campaignId: scope.campaignId, observationId: claim.observationId,
      workspaceId: scope.workspaceId, ownerId: scope.ownerId,
      expectedDigest: claim.expectedDigest,
      confirmsExactPersonEmailPair: true,
    });
  } catch {
    result = { status: 503, code: "CONTACT_ACCEPTANCE_UNCERTAIN" };
  }
  return finishContactBatchItem(db, claim, result, { now: now() });
}

export function startContactBatchWorker(db, { intervalMs = 8000 } = {}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 5000 ||
      intervalMs > 60000) throw new TypeError("Invalid batch interval");
  let busy = false;
  let stopped = false;
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try { await tickContactBatch(db); }
    catch { console.warn("[contact-batch] Worker requires operator review"); }
    finally { busy = false; }
  };
  const handle = setInterval(() => { void tick(); }, intervalMs);
  return () => { stopped = true; clearInterval(handle); };
}
