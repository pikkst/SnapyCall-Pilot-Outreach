// Continuation authorizations freeze only previously unattempted source jobs.
// The first immutable ResearchPersonSourceApproval remains untouched.
import { lockActiveWorkspaceMembership } from "./workspace-access.js";
import { personSourceJobSnapshot } from "./research-person-source-approval.js";
import { personSourceFingerprint } from "./research-person-source-queue.js";
import { requireResearchPriceEnvelope } from "./research-price-policy.js";

// Shared continuation-eligibility contract for an unattempted job.
export function eligibleUnattemptedContinuationSource(job, row) {
  return job?.cycleIndex === 0 && job.status === "QUEUED" &&
    job.attempts === 0 && job.spendReservationId == null &&
    row != null && row.candidateId == null && row.personSourceUrl == null &&
    ["UNCHECKED", "BLOCKED", "NO_EMAIL"].includes(row.emailTriageStatus) &&
    personSourceFingerprint(row) === job.evidenceFingerprint;
}

// Immutable continuation provider/price contract shared with the zero-yield
// stop. A stopped search must have been executable with the saved approval.
export function validateContinuationProviderPrice(setting, full, first) {
  if (!setting || setting.provider !== full.provider ||
      setting.model !== full.model || setting.provider !== first.provider ||
      setting.model !== first.model) {
    return { code: "APPROVED_PROVIDER_CHANGED" };
  }
  const price = requireResearchPriceEnvelope(setting);
  if (price.priceVersion !== full.priceVersion ||
      price.priceVersion !== first.priceVersion ||
      price.worstCaseCents !== first.worstCasePerCallCents) {
    return { code: "SOURCE_PRICE_CHANGED" };
  }
  return { code: null, price };
}

export const SOURCE_CYCLE_SIZE = 25;
export const MAX_SOURCE_CYCLES = 10;
const TERMINAL = new Set(["COMPLETED", "PARTIAL_BUDGET", "TARGET_REACHED"]);
const ACTIVE = new Set(["APPROVED", "RUNNING"]);

export async function createNextSourceCycle(db, {
  campaignId, workspaceId, ownerId,
}, { now = new Date() } = {}) {
  return db.$transaction(async tx => {
    if (!await lockActiveWorkspaceMembership(tx, {
      workspaceId, userId: ownerId,
    })) return { status: "BLOCKED", code: "WORKSPACE_ACCESS_REVOKED" };
    const campaigns = await tx.$queryRaw`
      SELECT "id","status" FROM "ResearchCampaign"
      WHERE "id" = ${campaignId} AND "workspaceId" = ${workspaceId}
        AND "ownerId" = ${ownerId} FOR UPDATE`;
    if (campaigns.length !== 1 || !["PARTIAL", "COMPLETED"].includes(
      campaigns[0].status)) return { status: "BLOCKED", code: "DISCOVERY_NOT_TERMINAL" };
    const full = await tx.researchFullRun.findUnique({ where: { campaignId } });
    const first = await tx.researchPersonSourceApproval.findUnique({
      where: { campaignId },
    });
    if (!full || !first || full.workspaceId !== workspaceId ||
        first.workspaceId !== workspaceId || full.ownerId !== ownerId ||
        first.ownerId !== ownerId || full.status !== "SOURCE_RUNNING" ||
        !TERMINAL.has(first.status) || !(full.expiresAt instanceof Date) ||
        full.expiresAt <= now) {
      return { status: "BLOCKED", code: "SOURCE_CONTINUATION_NOT_AUTHORIZED" };
    }
    const setting = await tx.aiSetting.findUnique({
      where: { ownerId }, select: { provider: true, model: true },
    });
    const validation = validateContinuationProviderPrice(setting, full, first);
    if (validation.code) {
      return { status: "BLOCKED", code: validation.code };
    }
    const { price } = validation;
    const cycles = await tx.researchPersonSourceCycle.findMany({
      where: { campaignId }, orderBy: { cycleIndex: "asc" },
      take: MAX_SOURCE_CYCLES + 1,
    });
    if (cycles.length > MAX_SOURCE_CYCLES ||
        cycles.some((cycle, i) => cycle.cycleIndex !== i + 1 ||
          cycle.workspaceId !== workspaceId || cycle.ownerId !== ownerId ||
          cycle.provider !== full.provider || cycle.model !== full.model ||
          cycle.priceVersion !== full.priceVersion ||
          cycle.worstCasePerCallCents !== price.worstCaseCents)) {
      return { status: "BLOCKED", code: "SOURCE_CYCLE_HISTORY_INVALID" };
    }
    const previous = cycles.at(-1);
    if (previous && ACTIVE.has(previous.status)) {
      return { status: "WAITING", code: "SOURCE_CYCLE_IN_PROGRESS" };
    }
    if (previous && !TERMINAL.has(previous.status)) {
      return { status: "BLOCKED", code: "SOURCE_CYCLE_RECONCILIATION_REQUIRED" };
    }
    // Unknown billed/expired work anywhere in the campaign prevents further
    // authorization, even if that work belongs to an older cycle.
    const unsettled = await tx.researchPersonSourceJob.count({
      where: { campaignId, status: { in: ["RUNNING", "PAUSED"] } },
    });
    if (unsettled) return { status: "BLOCKED", code: "SOURCE_JOB_UNSETTLED" };
    const spentCalls = first.startedCalls + cycles.reduce(
      (sum, cycle) => sum + cycle.startedCalls, 0);
    const spentCents = first.committedWorstCaseCents + cycles.reduce(
      (sum, cycle) => sum + cycle.committedWorstCaseCents, 0);
    const leftCalls = full.maxSourceCalls - spentCalls;
    const leftCents = full.maxSourceWorstCaseCents - spentCents;
    if (leftCalls < 1 || leftCents < price.worstCaseCents ||
        cycles.length >= MAX_SOURCE_CYCLES) {
      return { status: "EXHAUSTED", code: "SOURCE_CONTINUATION_BUDGET_EXHAUSTED" };
    }
    const available = await tx.researchPersonSourceJob.findMany({
      where: { campaignId, cycleIndex: 0, status: "QUEUED",
        attempts: 0, spendReservationId: null },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 251,
    });
    if (available.length > 250) return { status: "BLOCKED",
      code: "SOURCE_JOB_MANIFEST_CAP_EXCEEDED" };
    if (!available.length) {
      return { status: "EXHAUSTED", code: "NO_UNATTEMPTED_SOURCE_JOBS" };
    }
    // Previously queued jobs may have gained independently verified email
    // evidence since their first snapshot. Never make a redundant paid call
    // or attach stale person/source evidence to a fresh cycle.
    const liveRows = await tx.researchCampaignObservation.findMany({
      where: { campaignId,
        id: { in: available.map(job => job.observationId) } },
      select: { id: true, name: true, category: true, citationUrl: true,
        groundingStatus: true, groundingResolvedUrl: true,
        groundingProvenance: true, emailTriageStatus: true,
        candidateId: true, personSourceUrl: true },
      take: 251,
    });
    const byId = new Map(liveRows.map(row => [row.id, row]));
    const eligible = available.filter(job =>
      eligibleUnattemptedContinuationSource(job, byId.get(job.observationId)));
    if (!eligible.length) return { status: "EXHAUSTED",
      code: "NO_CURRENTLY_ELIGIBLE_SOURCE_JOBS" };
    const selected = eligible.slice(0, Math.min(
      SOURCE_CYCLE_SIZE, leftCalls, Math.floor(leftCents / price.worstCaseCents)));
    const cycleIndex = cycles.length + 1;
    const snapshot = personSourceJobSnapshot(selected);
    for (const job of selected) {
      const changed = await tx.researchPersonSourceJob.updateMany({
        where: { id: job.id, campaignId, cycleIndex: 0, status: "QUEUED",
          attempts: 0, spendReservationId: null,
          evidenceFingerprint: job.evidenceFingerprint },
        data: { cycleIndex },
      });
      if (changed.count !== 1) throw new Error("SOURCE_CYCLE_JOB_CAS_CONFLICT");
    }
    const approval = await tx.researchPersonSourceCycle.create({
      data: { campaignId, workspaceId, ownerId, cycleIndex,
        provider: setting.provider, model: setting.model,
        priceVersion: price.priceVersion,
        worstCasePerCallCents: price.worstCaseCents,
        maxCalls: selected.length,
        maxWorstCaseCents: selected.length * price.worstCaseCents,
        eligibleJobCount: selected.length,
        jobSnapshotHash: snapshot, expiresAt: full.expiresAt },
    });
    await tx.auditEvent.create({ data: {
      actorId: ownerId, entityId: campaignId,
      action: "research.person-source.continuation.approved",
      metadata: { workspaceId, cycleIndex, approvalId: approval.id,
        selectedCount: selected.length,
        remainingApprovedCalls: leftCalls - selected.length,
        automaticBillableReplay: false, contactCreated: false,
        sendingEnabled: false },
    } });
    return { status: "CREATED", code: "SOURCE_CYCLE_APPROVED",
      cycleIndex, count: selected.length };
  });
}

// The campaign lock guards both a claim and its finalization, so an older
// active cycle can never be simultaneously billed with the next one.
export async function finalizeSourceCycle(db, scope) {
  return db.$transaction(async tx => {
    if (!await lockActiveWorkspaceMembership(tx, {
      workspaceId: scope.workspaceId, userId: scope.ownerId,
    })) return { status: "BLOCKED", code: "WORKSPACE_ACCESS_REVOKED" };
    const rows = await tx.$queryRaw`
      SELECT "id" FROM "ResearchCampaign"
      WHERE "id" = ${scope.campaignId}
        AND "workspaceId" = ${scope.workspaceId}
        AND "ownerId" = ${scope.ownerId} FOR UPDATE`;
    if (rows.length !== 1) return { status: "BLOCKED", code: "CAMPAIGN_NOT_FOUND" };
    const cycle = await tx.researchPersonSourceCycle.findFirst({
      where: { campaignId: scope.campaignId,
        status: { in: ["APPROVED", "RUNNING"] } },
      orderBy: { cycleIndex: "desc" },
    });
    if (!cycle || cycle.workspaceId !== scope.workspaceId ||
        cycle.ownerId !== scope.ownerId) return { status: "IDLE" };
    const jobs = await tx.researchPersonSourceJob.findMany({
      where: { campaignId: scope.campaignId, cycleIndex: cycle.cycleIndex },
      take: SOURCE_CYCLE_SIZE + 1,
    });
    if (jobs.length !== cycle.eligibleJobCount ||
        personSourceJobSnapshot(jobs.map(job => ({
          ...job, status: "QUEUED",
        }))) !== cycle.jobSnapshotHash) {
      return { status: "BLOCKED", code: "SOURCE_CYCLE_MANIFEST_CHANGED" };
    }
    if (jobs.some(job => ["RUNNING", "PAUSED"].includes(job.status) ||
        (job.status === "COMPLETED" && job.proposedSourceUrl))) {
      return { status: "WAITING", code: "SOURCE_CYCLE_EVIDENCE_OR_BILLING_PENDING" };
    }
    const pending = jobs.filter(job => job.status === "QUEUED").length;
    const exhausted = cycle.startedCalls >= cycle.maxCalls ||
      cycle.committedWorstCaseCents + cycle.worstCasePerCallCents >
        cycle.maxWorstCaseCents;
    if (pending && !exhausted) return { status: "WAITING",
      code: "SOURCE_CYCLE_TASKS_AVAILABLE" };
    const terminal = pending ? "PARTIAL_BUDGET" : "COMPLETED";
    const changed = await tx.researchPersonSourceCycle.updateMany({
      where: { id: cycle.id, campaignId: scope.campaignId,
        workspaceId: scope.workspaceId, ownerId: scope.ownerId,
        status: { in: ["APPROVED", "RUNNING"] } },
      data: { status: terminal },
    });
    if (changed.count !== 1) throw new Error("SOURCE_CYCLE_FINALIZE_CONFLICT");
    return { status: terminal, code: "SOURCE_CYCLE_TERMINAL",
      cycleIndex: cycle.cycleIndex };
  });
}
