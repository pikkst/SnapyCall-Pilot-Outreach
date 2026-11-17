// Durable, review-only evidence for a leased research task.
// Called exclusively with normalized output from a trusted provider adapter.
// No email addresses, contact permissions or automatic Candidate creation.
import { createHash } from "node:crypto";
import { z } from "zod";
import { publicCitationUrl } from "./research-evidence.js";
import { completeResearchTask } from "./research-campaign-leases.js";
import { consecutiveQualityFailures, shouldStopForQuality } from "./research-quality-gate.js";

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
  now = new Date(), { beforeCommit = null, completionCode = null } = {}) {
  const observations = normalizeCampaignObservations(preview, claim.limit);
  if (completionCode !== null && (!["NO_VERIFIABLE_GROUNDING", "NO_USABLE_STRUCTURED_OUTPUT"].includes(completionCode) ||
      observations.length !== 0)) {
    throw new TypeError("Zero-evidence completion must have no observations");
  }
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
      observedCount: observations.length, completionCode, now,
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

    // The campaign row is already locked. Finalization must happen in the
    // SAME transaction as the lease CAS and deduplicated evidence insert.
    // Never mark terminal while another leased or uncertain-billing task
    // still needs settlement/reconciliation.
    const campaign = await tx.researchCampaign.findFirst({
      where: { id: claim.campaignId, workspaceId: claim.workspaceId,
        ownerId: claim.ownerId, status: "RUNNING" },
      select: { targetCount: true },
    });
    if (!campaign) throw new CampaignLeaseConflict();
    const unsettled = await tx.researchCampaignTask.count({
      where: { campaignId: claim.campaignId,
        status: { in: ["RUNNING", "PAUSED", "FAILED"] } },
    });
    let terminalStatus = null;
    let qualityFailureStreak = 0;
    if (unsettled === 0) {
      // Reuse persisted outcomes instead of a second counter. This query
      // executes under the existing campaign row lock, after the fenced
      // task completion, so another paid claim cannot race the STOP.
      const recentTasks = await tx.researchCampaignTask.findMany({
        where: { campaignId: claim.campaignId },
        select: { taskIndex: true, status: true, observedCount: true },
        orderBy: { taskIndex: "desc" },
        take: 3,
      });
      qualityFailureStreak = consecutiveQualityFailures(recentTasks);
      const unique = await tx.researchCampaignObservation.count({
        where: { campaignId: claim.campaignId },
      });
      if (unique >= campaign.targetCount) {
        // Prevent another paid claim after the threshold has been reached.
        await tx.researchCampaignTask.updateMany({
          where: { campaignId: claim.campaignId, status: "QUEUED" },
          data: { status: "CANCELLED" },
        });
        terminalStatus = "COMPLETED";
      } else if (shouldStopForQuality(recentTasks)) {
        // Do not cancel queued work: preserve the original approved plan,
        // evidence and cost ledger for review. The campaign status blocks
        // all new paid claims and distinguishes quality STOP from billing.
        terminalStatus = "QUALITY_STOP";
      } else {
        const queued = await tx.researchCampaignTask.count({
          where: { campaignId: claim.campaignId, status: "QUEUED" },
        });
        if (queued === 0) terminalStatus = "PARTIAL";
      }
    }
    if (terminalStatus) {
      const transition = await tx.researchCampaign.updateMany({
        where: { id: claim.campaignId, workspaceId: claim.workspaceId,
          ownerId: claim.ownerId, status: "RUNNING" },
        data: { status: terminalStatus },
      });
      if (transition.count !== 1) throw new CampaignLeaseConflict();
      await tx.auditEvent.create({ data: {
        actorId: claim.ownerId, action: "research.campaign.finalized",
        entityId: claim.campaignId, metadata: {
          workspaceId: claim.workspaceId, status: terminalStatus,
          ...(terminalStatus === "QUALITY_STOP"
            ? { qualityFailureStreak, reason: "THREE_CONSECUTIVE_ZERO_EVIDENCE_RESULTS",
                automaticProviderRetry: false } : {}),
          contactVerification: "NOT_PERFORMED", sendingEnabled: false,
        },
      } });
    }
    return Object.freeze({
      observed: observations.length,
      uniqueAdded: saved.count,
      duplicates: observations.length - saved.count,
      ...(terminalStatus ? { campaignStatus: terminalStatus } : {}),
    });
  });
}

// Read-only operational projection. Persisted terminal transitions and
// spend reconciliation are separate explicitly authorized operations.
export function deriveCampaignOperationalState(campaign, now = new Date()) {
  if (!campaign || !Array.isArray(campaign.tasks) ||
      !(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      !Number.isInteger(campaign._count?.observations) ||
      campaign._count.observations < 0 ||
      !Number.isInteger(campaign.targetCount) || campaign.targetCount < 1) {
    throw new TypeError("Invalid campaign operational state");
  }
  const allowed = new Set(["QUEUED", "RUNNING", "COMPLETED",
    "PAUSED", "FAILED", "CANCELLED"]);
  if (campaign.tasks.some(task => !allowed.has(task.status))) {
    throw new TypeError("Invalid campaign task status");
  }
  const expired = campaign.tasks.filter(task => task.status === "RUNNING" &&
    (!(task.leaseUntil instanceof Date) || task.leaseUntil <= now));
  const unresolved = campaign.tasks.filter(task =>
    task.status === "PAUSED" || task.status === "FAILED");
  const running = campaign.tasks.filter(task => task.status === "RUNNING");
  const queued = campaign.tasks.filter(task => task.status === "QUEUED");
  const targetReached = campaign._count.observations >= campaign.targetCount;
  // A persisted cancelled campaign is final even if old task leases
  // still need monetary reconciliation; surface both independently.
  if (campaign.status === "QUALITY_STOP") {
    return { operationalState: unresolved.length || running.length
      ? "RECOVERY_REQUIRED" : "QUALITY_STOP",
      action: unresolved.length || running.length ? "RECONCILE_SPEND"
        : "REVIEW_RESEARCH_QUALITY",
      expiredLeases: expired.length,
      needsReconciliation: !!(unresolved.length || running.length) };
  }
  if (campaign.status === "CANCELLED") {
    return { operationalState: "CANCELLED",
      action: expired.length || unresolved.length ? "RECONCILE_SPEND" : "NONE",
      expiredLeases: expired.length, needsReconciliation: !!(expired.length || unresolved.length) };
  }
  // A persisted terminal record must not be accidentally re-opened by a
  // presentation-only read. Flag inconsistent task state for reconciliation.
  if (["COMPLETED", "PARTIAL", "FAILED"].includes(campaign.status)) {
    return { operationalState: running.length || unresolved.length ?
      "RECOVERY_REQUIRED" : campaign.status,
    action: running.length || unresolved.length ? "RECONCILE_SPEND" : "NONE",
    expiredLeases: expired.length,
    needsReconciliation: !!(running.length || unresolved.length) };
  }
  if (expired.length) return { operationalState: "RECOVERY_REQUIRED",
    action: "RECONCILE_EXPIRED_LEASES",
    expiredLeases: expired.length, needsReconciliation: true };
  if (unresolved.length || campaign.status === "PAUSED") {
    return { operationalState: "PAUSED_REVIEW",
      action: "REVIEW_FAILED_TASKS", expiredLeases: 0,
      needsReconciliation: true };
  }
  if (running.length) return { operationalState: "RUNNING",
    action: "CHECK_PROGRESS", expiredLeases: 0,
    needsReconciliation: false };
  if (targetReached) return { operationalState: "TARGET_REACHED",
    action: "FINALIZE_CAMPAIGN", expiredLeases: 0,
    needsReconciliation: false };
  if (!queued.length) return { operationalState: "PARTIAL",
    action: "FINALIZE_CAMPAIGN", expiredLeases: 0,
    needsReconciliation: false };
  const ready = queued.some(task => task.nextAttemptAt == null ||
    (task.nextAttemptAt instanceof Date && task.nextAttemptAt <= now));
  if (!ready) return { operationalState: "WAITING_RETRY",
    action: "WAIT_FOR_NEXT_ELIGIBLE_TASK", expiredLeases: 0,
    needsReconciliation: false };
  return { operationalState: "READY",
    action: "EXECUTE_EXPLICIT_BOUNDED_SLICE", expiredLeases: 0,
    needsReconciliation: false };
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
    ...deriveCampaignOperationalState(campaign),
    uniqueSourcedCandidates: unique,
    targetReached: unique >= campaign.targetCount,
    rawCandidateObservations: rawObservations,
    duplicateObservations: Math.max(0, rawObservations - unique),
    plannedTasks: campaign.tasks.length, tasks: byStatus,
    noGroundingTasks: campaign.tasks.filter(task => task.status === "COMPLETED" &&
      task.lastErrorCode === "NO_VERIFIABLE_GROUNDING").length,
    invalidOutputTasks: campaign.tasks.filter(task => task.status === "COMPLETED" &&
      task.lastErrorCode === "NO_USABLE_STRUCTURED_OUTPUT").length,
    qualityFailureStreak: consecutiveQualityFailures(
      campaign.tasks.filter(task => Number.isInteger(task.taskIndex))),
    qualityStop: campaign.status === "QUALITY_STOP",
    pausedTaskReview: campaign.tasks.filter(task =>
      task.status === "PAUSED" && Number.isInteger(task.taskIndex) &&
      task.lastErrorCode === "BILLING_UNCERTAIN").map(task => ({
      taskIndex: task.taskIndex, lastErrorCode: "BILLING_UNCERTAIN",
    })),
    contactVerification: "NOT_PERFORMED",
    sendingEnabled: false,
  });
}
