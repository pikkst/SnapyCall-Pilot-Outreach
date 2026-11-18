// Deterministic extension of the immutable 24-query discovery planner.
// These are NEW approved search tasks, never retries of a billable attempt.
// Each task is generated at most once under the locked campaign row.
import { createHash } from "node:crypto";
import { planResearchCampaign } from "./research-campaign-planner.js";

const MAX_PLANNED_TASKS = 250;
const MAX_STORED_EVIDENCE = 250;
const FOCUSES = Object.freeze([
  "consultants with independent professional biography pages",
  "service professionals publishing a direct professional contact address",
  "educators and advisors with named public profile pages",
  "speakers and practitioners with original business websites",
  "experts with personal consulting or booking pages",
  "professional founders with verifiable named profiles",
  "remote service providers with publicly attributed credentials",
  "independent specialists with clear published expertise",
]);

export function nextAdaptiveDiscoveryTask({ query, targetCount, planVersion,
  idempotencyKey }, index) {
  if (!Number.isInteger(index) || index < 24 ||
      index >= MAX_PLANNED_TASKS) {
    throw new TypeError("Adaptive discovery index must be within 24..249");
  }
  const base = planResearchCampaign({
    query, targetCount, idempotencyKey,
  });
  if (base.planVersion !== planVersion || base.tasks.length !== 24) {
    throw new TypeError("Known campaign planner version required");
  }
  const seed = base.tasks[index % base.tasks.length];
  const focus = FOCUSES[
    Math.floor((index - base.tasks.length) / base.tasks.length) % FOCUSES.length
  ];
  const round = 1 + Math.floor(
    (index - base.tasks.length) / base.tasks.length);
  const fullQuery = [
    query, "Find additional independent experts in",
    seed.region + "; focus on", seed.facet + "; prioritize", focus + ".",
    "Distinct discovery round", String(round),
  ].join(" ");
  if (fullQuery.length > 430) {
    throw new TypeError("Adaptive query exceeds controlled context bound");
  }
  return Object.freeze({
    index, limit: seed.limit, query: fullQuery,
    region: seed.region, facet: seed.facet,
    key: createHash("sha256").update(JSON.stringify([
      "ai98-adaptive-discovery-v1", planVersion, index, fullQuery,
    ])).digest("hex"),
  });
}

export async function maybeAppendAdaptiveDiscoveryTask(tx, {
  campaignId, workspaceId, ownerId, campaign, observedCount, now,
}) {
  const full = await tx.researchFullRun?.findUnique({
    where: { campaignId },
    select: { status: true, workspaceId: true, ownerId: true,
      maxDiscoveryCalls: true, expiresAt: true },
  });
  if (!full) return { applicable: false, appended: false };
  if (full.workspaceId !== workspaceId || full.ownerId !== ownerId ||
      full.status !== "DISCOVERY" ||
      !(full.expiresAt instanceof Date) || full.expiresAt <= now) {
    return { applicable: true, appended: false,
      reason: "FULL_RUN_AUTHORIZATION_INACTIVE" };
  }
  if (observedCount >= MAX_STORED_EVIDENCE) {
    return { applicable: true, appended: false,
      reason: "EVIDENCE_INSPECTION_CAP_REACHED" };
  }
  const approved = await tx.researchCampaignRun.findUnique({
    where: { campaignId },
    select: { status: true, maxTasks: true, startedTasks: true,
      maxWorstCaseCents: true, committedWorstCaseCents: true,
      worstCasePerCallCents: true, expiresAt: true,
      workspaceId: true, ownerId: true },
  });
  if (!approved || approved.workspaceId !== workspaceId ||
      approved.ownerId !== ownerId ||
      !["APPROVED", "RUNNING"].includes(approved.status) ||
      !(approved.expiresAt instanceof Date) || approved.expiresAt <= now ||
      approved.maxTasks !== full.maxDiscoveryCalls ||
      approved.startedTasks >= approved.maxTasks ||
      approved.committedWorstCaseCents + approved.worstCasePerCallCents >
        approved.maxWorstCaseCents) {
    return { applicable: true, appended: false,
      reason: "DISCOVERY_APPROVED_BUDGET_EXHAUSTED" };
  }
  const taskCount = await tx.researchCampaignTask.count({
    where: { campaignId },
  });
  // Never regenerate initial tasks or exceed immutable max-task entitlement.
  if (taskCount < 24 || taskCount >= Math.min(
    approved.maxTasks, MAX_PLANNED_TASKS)) {
    return { applicable: true, appended: false,
      reason: "DISCOVERY_TASK_CAP_REACHED" };
  }
  const prior = await tx.researchCampaignTask.findFirst({
    where: { campaignId }, select: { taskIndex: true },
    orderBy: { taskIndex: "desc" },
  });
  if (!prior || prior.taskIndex !== taskCount - 1) {
    return { applicable: true, appended: false,
      reason: "DISCOVERY_TASK_MANIFEST_CHANGED" };
  }
  const task = nextAdaptiveDiscoveryTask(campaign, taskCount);
  await tx.researchCampaignTask.create({
    data: { campaignId, taskIndex: task.index,
      taskKey: task.key, query: task.query,
      region: task.region, facet: task.facet,
      resultLimit: task.limit, status: "QUEUED" },
  });
  return { applicable: true, appended: true,
    taskIndex: task.index, reason: "ADAPTIVE_TASK_APPENDED" };
}
