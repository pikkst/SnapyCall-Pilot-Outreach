// One human batch review over an exact, tenant-scoped immutable manifest.
// No research calls, no email sends and no unchecked Candidate creation.
import { createHash } from "node:crypto";
import { isWorkspaceId, lockActiveWorkspaceMembership,
  requireWorkspaceMembership } from "./workspace-access.js";
import { observationInspectionSource } from "./research-observation-email.js";
import { summarizeQualifiedEmailEvidence } from "./research-qualified-evidence.js";

const MAX_SNAPSHOT = 250;
const MAX_BATCH = 100;
const SHA = /^[a-f0-9]{64}$/;
const select = {
  id: true, name: true, category: true, citationUrl: true,
  groundingStatus: true, groundingResolvedUrl: true,
  groundingProvenance: true, personSourceUrl: true,
  personSourceProvenance: true, personSourceVerifiedAt: true,
  emailTriageStatus: true, emailTriageCode: true,
  emailTriageEmail: true, emailTriageDigest: true,
  emailTriageAt: true, candidateId: true,
};

export function buildQualifiedContactManifest(rows) {
  const summary = summarizeQualifiedEmailEvidence(rows);
  if (!summary.countReliable || !Array.isArray(rows) ||
      rows.length > MAX_SNAPSHOT) {
    return Object.freeze({ reliable: false, entries: Object.freeze([]),
      totalQualified: 0, manifestHash: null, sendingEnabled: false });
  }
  const sources = new Map();
  const emails = new Map();
  for (const row of rows) {
    const source = observationInspectionSource(row);
    if (source) sources.set(source, (sources.get(source) ?? 0) + 1);
    if (typeof row?.emailTriageEmail === "string") {
      const email = row.emailTriageEmail.toLowerCase();
      emails.set(email, (emails.get(email) ?? 0) + 1);
    }
  }
  const entries = [];
  for (const row of rows) {
    if (typeof row?.id !== "string" || !isWorkspaceId(row.id) ||
        row.candidateId != null || !SHA.test(row.emailTriageDigest ?? "")) continue;
    const source = observationInspectionSource(row);
    if (!source || sources.get(source) !== 1 ||
        emails.get(row.emailTriageEmail) !== 1 ||
        summarizeQualifiedEmailEvidence([row]).qualifiedEvidence !== 1) continue;
    entries.push(Object.freeze({
      observationId: row.id, name: row.name, category: row.category,
      email: row.emailTriageEmail, sourceUrl: source,
      evidenceDigest: row.emailTriageDigest,
      inspectedAt: row.emailTriageAt.toISOString(),
    }));
  }
  entries.sort((a, b) => a.observationId.localeCompare(b.observationId));
  const selected = Object.freeze(entries.slice(0, MAX_BATCH));
  const manifestHash = selected.length ? createHash("sha256").update(
    JSON.stringify(["ai98-qualified-contact-batch-v1",
      ...selected.map(entry => [
        entry.observationId, entry.name, entry.category, entry.email,
        entry.sourceUrl, entry.evidenceDigest, entry.inspectedAt,
      ])])).digest("hex") : null;
  return Object.freeze({
    reliable: true, totalQualified: summary.qualifiedEvidence,
    eligibleForBatch: entries.length,
    selectedCount: selected.length, manifestHash,
    entries: selected, sendingEnabled: false,
  });
}

export async function readQualifiedContactManifest(db, {
  campaignId, workspaceId, ownerId,
}) {
  if (![campaignId, workspaceId, ownerId].every(isWorkspaceId)) {
    throw new TypeError("Owner-scoped campaign required");
  }
  if (!await requireWorkspaceMembership(db, {
    workspaceId, userId: ownerId,
  })) return { status: 403, code: "WORKSPACE_ACCESS_REVOKED" };
  const campaign = await db.researchCampaign.findFirst({
    where: { id: campaignId, workspaceId, ownerId },
    select: { id: true, status: true },
  });
  if (!campaign) return { status: 404, code: "CAMPAIGN_NOT_FOUND" };
  if (!["COMPLETED", "PARTIAL"].includes(campaign.status)) {
    return { status: 409, code: "DISCOVERY_NOT_TERMINAL" };
  }
  const rows = await db.researchCampaignObservation.findMany({
    where: { campaignId }, select, orderBy: { id: "asc" },
    take: MAX_SNAPSHOT + 1,
  });
  // Revocation can race with the aggregate read. Never leak person-email
  // pairs to a session whose workspace access has been withdrawn.
  if (!await requireWorkspaceMembership(db, {
    workspaceId, userId: ownerId,
  })) return { status: 403, code: "WORKSPACE_ACCESS_REVOKED" };
  return { status: 200, ...buildQualifiedContactManifest(rows) };
}

export async function approveQualifiedContactBatch(db, {
  campaignId, workspaceId, ownerId, manifestHash,
  confirmEveryDisplayedPair, confirmNoAutomaticSending,
}) {
  if (![campaignId, workspaceId, ownerId].every(isWorkspaceId) ||
      typeof manifestHash !== "string" || !SHA.test(manifestHash) ||
      confirmEveryDisplayedPair !== true ||
      confirmNoAutomaticSending !== true) {
    throw new TypeError("Exact reviewed contact manifest approval required");
  }
  return db.$transaction(async tx => {
    if (!await lockActiveWorkspaceMembership(tx, {
      workspaceId, userId: ownerId,
    })) return { status: 403, code: "WORKSPACE_ACCESS_REVOKED" };
    const campaigns = await tx.$queryRaw`
      SELECT "id","status" FROM "ResearchCampaign" WHERE "id" = ${campaignId}
        AND "workspaceId" = ${workspaceId}
        AND "ownerId" = ${ownerId} FOR UPDATE`;
    if (campaigns.length !== 1) return { status: 404, code: "CAMPAIGN_NOT_FOUND" };
    if (!["COMPLETED", "PARTIAL"].includes(campaigns[0].status)) {
      return { status: 409, code: "DISCOVERY_NOT_TERMINAL" };
    }
    const prior = await tx.researchContactBatch.findUnique({
      where: { campaignId },
    });
    if (prior) {
      const same = prior.workspaceId === workspaceId && prior.ownerId === ownerId &&
        prior.manifestHash === manifestHash;
      return same ? { status: 200, code: "CONTACT_BATCH_ALREADY_APPROVED",
        batchId: prior.id, count: prior.itemCount, sendingEnabled: false }
        : { status: 409, code: "CONTACT_BATCH_MANIFEST_IMMUTABLE" };
    }
    const count = await tx.researchCampaignObservation.count({
      where: { campaignId },
    });
    if (count < 1 || count > MAX_SNAPSHOT) {
      return { status: 409, code: "CONTACT_BATCH_SNAPSHOT_CAP_EXCEEDED" };
    }
    const rows = await tx.researchCampaignObservation.findMany({
      where: { campaignId }, select, orderBy: { id: "asc" },
      take: MAX_SNAPSHOT + 1,
    });
    if (rows.length !== count) {
      return { status: 409, code: "CONTACT_BATCH_SNAPSHOT_CHANGED" };
    }
    const manifest = buildQualifiedContactManifest(rows);
    if (!manifest.reliable || manifest.selectedCount === 0 ||
        manifest.manifestHash !== manifestHash) {
      return { status: 409, code: "CONTACT_BATCH_MANIFEST_CHANGED" };
    }
    const batch = await tx.researchContactBatch.create({ data: {
      campaignId, workspaceId, ownerId,
      manifestHash, itemCount: manifest.selectedCount,
    } });
    await tx.researchContactBatchItem.createMany({
      data: manifest.entries.map(entry => ({
        batchId: batch.id, observationId: entry.observationId,
        expectedDigest: entry.evidenceDigest, status: "QUEUED",
      })),
    });
    await tx.auditEvent.create({ data: {
      actorId: ownerId, entityId: batch.id,
      action: "research.campaign.qualified-batch.approved",
      metadata: { workspaceId, campaignId, manifestHash,
        count: manifest.selectedCount,
        exactPairReviewConfirmed: true, automaticSending: false },
    } });
    return { status: 201, code: "CONTACT_BATCH_APPROVED",
      batchId: batch.id, count: manifest.selectedCount,
      sendingEnabled: false };
  });
}
