// Durable, review-only evidence for a leased research task.
// Called exclusively with normalized output from a trusted provider adapter.
// No email addresses, contact permissions or automatic Candidate creation.
import { createHash } from "node:crypto";
import { z } from "zod";
import { publicCitationUrl } from "./research-evidence.js";
import { completeResearchTask } from "./research-campaign-leases.js";

const observationSchema = z.object({
  name: z.string().trim().min(2).max(160),
  category: z.enum(["AI_AUTOMATION", "COACHING", "MARKETING_GROWTH", "BUSINESS_STRATEGY"]),
  sourceUrl: z.string().url().max(2048),
  rationale: z.string().trim().min(8).max(700),
}).passthrough();

export class CampaignLeaseConflict extends Error {
  constructor() {
    super("Task lease expired, changed or was cancelled");
    this.name = "CampaignLeaseConflict";
  }
}

export function normalizeCampaignObservations(preview, limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20 ||
      !Array.isArray(preview?.candidates) || preview.candidates.length > limit ||
      !Array.isArray(preview?.sources) || preview.sources.length > 60) {
    throw new TypeError("Invalid campaign research envelope");
  }
  const cited = new Set(preview.sources.map(entry =>
    publicCitationUrl(entry?.url)).filter(Boolean));
  const unique = new Map();
  for (const candidate of preview.candidates) {
    const parsed = observationSchema.parse(candidate);
    const url = publicCitationUrl(parsed.sourceUrl);
    if (!url || !cited.has(url)) {
      throw new TypeError("Candidate source missing from provider citations");
    }
    const name = parsed.name.replace(/\s+/g, " ").trim();
    // Deliberately conservative: do not merge namesakes across different
    // public citations or assume a company inbox belongs to an individual.
    const evidenceKey = createHash("sha256").update(JSON.stringify([
      name.toLocaleLowerCase("en-US"), parsed.category, url,
    ])).digest("hex");
    if (!unique.has(evidenceKey)) {
      unique.set(evidenceKey, {
        evidenceKey, name, category: parsed.category,
        citationUrl: url, rationale: parsed.rationale, status: "UNVERIFIED",
      });
    }
  }
  return Object.freeze([...unique.values()]);
}

// One transaction fences the lease AND commits the provider's cited records.
// A stale worker cannot insert observations. Uniqueness is enforced across
// campaign tasks by PostgreSQL, not by process-local memory.
export async function commitCampaignResearchResult(db, claim, preview,
  now = new Date(), { beforeCommit = null } = {}) {
  const observations = normalizeCampaignObservations(preview, claim.limit);
  if (beforeCommit !== null && typeof beforeCommit !== "function") {
    throw new TypeError("Invalid membership guard");
  }
  return db.$transaction(async tx => {
    // Recheck live workspace membership inside the evidence write transaction.
    // A revoked user cannot commit provider findings after a paid search.
    if (beforeCommit && !(await beforeCommit(tx))) throw new CampaignLeaseConflict();
    // Serialize provider results with subsequent target-count checks before
    // another paid task is claimed. Claim uses the same campaign row lock.
    const campaignRows = await tx.$queryRaw`
      SELECT "id" FROM "ResearchCampaign"
      WHERE "id" = ${claim.campaignId}
        AND "workspaceId" = ${claim.workspaceId}
        AND "ownerId" = ${claim.ownerId}
        AND "status" = 'RUNNING'
      FOR UPDATE`;
    if (campaignRows.length !== 1) throw new CampaignLeaseConflict();
    const applied = await completeResearchTask(tx, claim, {
      observedCount: observations.length, now,
    });
    if (!applied) throw new CampaignLeaseConflict();
    const saved = observations.length ? await tx.researchCampaignObservation.createMany({
      data: observations.map(item => ({
        campaignId: claim.campaignId, taskId: claim.taskId,
        evidenceKey: item.evidenceKey, name: item.name, category: item.category,
        citationUrl: item.citationUrl, rationale: item.rationale,
        status: item.status,
      })),
      skipDuplicates: true,
    }) : { count: 0 };
    return Object.freeze({
      observed: observations.length,
      uniqueAdded: saved.count,
      duplicates: observations.length - saved.count,
    });
  });
}

export function summarizeCampaignProgress(campaign) {
  if (!campaign || !Array.isArray(campaign.tasks) ||
      !Number.isInteger(campaign.targetCount) || campaign.targetCount < 1 ||
      !Number.isInteger(campaign._count?.observations) ||
      campaign._count.observations < 0) {
    throw new TypeError("Invalid campaign progress snapshot");
  }
  const allowed = new Set(["QUEUED", "RUNNING", "COMPLETED", "PAUSED", "FAILED", "CANCELLED"]);
  const byStatus = { queued: 0, running: 0, completed: 0, paused: 0,
    failed: 0, cancelled: 0 };
  let rawObservations = 0;
  for (const task of campaign.tasks) {
    if (!allowed.has(task.status) ||
        !Number.isInteger(task.observedCount) || task.observedCount < 0 ||
        task.observedCount > task.resultLimit) {
      throw new TypeError("Invalid campaign task status");
    }
    byStatus[task.status.toLowerCase()]++;
    rawObservations += task.observedCount;
  }
  const unique = campaign._count.observations;
  return Object.freeze({
    id: campaign.id, status: campaign.status, targetCount: campaign.targetCount,
    uniqueSourcedCandidates: unique,
    targetReached: unique >= campaign.targetCount,
    rawCandidateObservations: rawObservations,
    duplicateObservations: Math.max(0, rawObservations - unique),
    plannedTasks: campaign.tasks.length, tasks: byStatus,
    contactVerification: "NOT_PERFORMED",
    sendingEnabled: false,
  });
}
