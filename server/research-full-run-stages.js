// Stage handoff for a single upfront, bounded and explicitly authorized
// discovery -> email-triage -> person-source research workflow.
// All paid calls remain delegated to existing ledger/lease-fenced workers.
// This controller never creates Candidates or enables email sending.
import { lockActiveWorkspaceMembership } from "./workspace-access.js";
import { approveEmailTriage } from "./research-email-triage-worker.js";
import { enqueuePersonSourceJobs } from "./research-person-source-queue.js";
import { approvePersonSourceResearch } from "./research-person-source-approval.js";
import { summarizeQualifiedEmailEvidence } from "./research-qualified-evidence.js";
import { requireResearchPriceEnvelope } from "./research-price-policy.js";

const ACTIVE_STAGES = new Set([
  "DISCOVERY", "EMAIL_TRIAGE", "SOURCE_PREPARE", "SOURCE_RUNNING",
]);
const TERMINAL_CAMPAIGN = new Set(["COMPLETED", "PARTIAL"]);
const MAX_OBSERVATIONS = 250;

export async function transitionFullRunStage(db, scope, {
  from, to, code, now = new Date(),
}) {
  if (!ACTIVE_STAGES.has(from) || typeof to !== "string" ||
      !Number.isFinite(now.getTime())) {
    throw new TypeError("A valid source-stage transition is required");
  }
  return db.$transaction(async tx => {
    if (!await lockActiveWorkspaceMembership(tx, {
      workspaceId: scope.workspaceId, userId: scope.ownerId,
    })) return { status: "BLOCKED", code: "WORKSPACE_ACCESS_REVOKED" };
    const campaign = await tx.$queryRaw`
      SELECT "id" FROM "ResearchCampaign"
      WHERE "id" = ${scope.campaignId}
        AND "workspaceId" = ${scope.workspaceId}
        AND "ownerId" = ${scope.ownerId} FOR UPDATE`;
    if (campaign.length !== 1) {
      return { status: "BLOCKED", code: "CAMPAIGN_NOT_FOUND" };
    }
    const current = await tx.researchFullRun.findUnique({
      where: { campaignId: scope.campaignId },
    });
    if (!current || current.workspaceId !== scope.workspaceId ||
        current.ownerId !== scope.ownerId) {
      return { status: "BLOCKED", code: "FULL_RUN_NOT_FOUND" };
    }
    if (current.status !== from) {
      return { status: "UNCHANGED", code: "FULL_RUN_STAGE_ALREADY_CHANGED" };
    }
    if (current.expiresAt <= now && !["PARTIAL", "NEEDS_REVIEW"].includes(to)) {
      to = "NEEDS_REVIEW";
      code = "FULL_RUN_APPROVAL_EXPIRED";
    }
    const updated = await tx.researchFullRun.updateMany({
      where: { id: current.id, campaignId: scope.campaignId,
        workspaceId: scope.workspaceId, ownerId: scope.ownerId,
        status: from },
      data: { status: to, lastCode: code },
    });
    if (updated.count !== 1) {
      return { status: "UNCHANGED", code: "FULL_RUN_STAGE_RACE" };
    }
    await tx.auditEvent.create({ data: {
      actorId: scope.ownerId, entityId: scope.campaignId,
      action: "research.full-run.stage.changed",
      metadata: { workspaceId: scope.workspaceId,
        priorStage: from, stage: to, code,
        paidReplay: false, contactCreated: false, sendingEnabled: false },
    } });
    return { status: to, code };
  });
}

// Count verified, non-colliding, named public email EVIDENCE, not observations.
// These are still not approved contacts or eligible outreach recipients.
export async function qualifiedFullRunProgress(db, scope) {
  const count = await db.researchCampaignObservation.count({
    where: { campaignId: scope.campaignId },
  });
  if (count > MAX_OBSERVATIONS) {
    return { reliable: false, qualifiedEvidence: 0,
      code: "QUALIFIED_EVIDENCE_SNAPSHOT_LIMIT" };
  }
  const rows = await db.researchCampaignObservation.findMany({
    where: { campaignId: scope.campaignId }, take: MAX_OBSERVATIONS + 1,
    select: { name: true, category: true, citationUrl: true,
      groundingStatus: true, groundingResolvedUrl: true,
      groundingProvenance: true, personSourceUrl: true,
      personSourceProvenance: true, personSourceVerifiedAt: true,
      emailTriageStatus: true, emailTriageCode: true,
      emailTriageEmail: true, emailTriageDigest: true, emailTriageAt: true },
  });
  if (rows.length !== count) return { reliable: false,
    qualifiedEvidence: 0, code: "QUALIFIED_EVIDENCE_SNAPSHOT_CHANGED" };
  const result = summarizeQualifiedEmailEvidence(rows);
  return { reliable: result.countReliable,
    qualifiedEvidence: result.qualifiedEvidence,
    code: result.countReliable ? "QUALIFIED_EVIDENCE_COUNTED" :
      "QUALIFIED_EVIDENCE_SNAPSHOT_UNRELIABLE" };
}

// A target reached while source searches are still authorized must STOP
// future paid claims in the SAME campaign-locked transaction as the full-run
// completion. An already leased call may settle but can never be replayed.
export async function stopFullRunSourceAtGoal(db, scope) {
  return db.$transaction(async tx => {
    if (!await lockActiveWorkspaceMembership(tx, {
      workspaceId: scope.workspaceId, userId: scope.ownerId,
    })) return { status: "BLOCKED", code: "WORKSPACE_ACCESS_REVOKED" };
    const campaigns = await tx.$queryRaw`
      SELECT "id" FROM "ResearchCampaign" WHERE "id" = ${scope.campaignId}
        AND "workspaceId" = ${scope.workspaceId}
        AND "ownerId" = ${scope.ownerId} FOR UPDATE`;
    if (campaigns.length !== 1) {
      return { status: "BLOCKED", code: "CAMPAIGN_NOT_FOUND" };
    }
    const full = await tx.researchFullRun.findUnique({
      where: { campaignId: scope.campaignId },
    });
    if (!full || full.status !== "SOURCE_RUNNING" ||
        full.workspaceId !== scope.workspaceId ||
        full.ownerId !== scope.ownerId) {
      return { status: "UNCHANGED", code: "FULL_RUN_STAGE_ALREADY_CHANGED" };
    }
    const source = await tx.researchPersonSourceApproval.findUnique({
      where: { campaignId: scope.campaignId },
    });
    if (!source || source.workspaceId !== scope.workspaceId ||
        source.ownerId !== scope.ownerId ||
        source.model !== full.model || source.provider !== full.provider ||
        source.priceVersion !== full.priceVersion ||
        !["APPROVED", "RUNNING", "COMPLETED", "PARTIAL_BUDGET",
          "TARGET_REACHED"].includes(source.status)) {
      return { status: "BLOCKED", code: "SOURCE_APPROVAL_NEEDS_REVIEW" };
    }
    const progress = await qualifiedFullRunProgress(tx, scope);
    if (!progress.reliable) return { status: "BLOCKED", code: progress.code };
    if (progress.qualifiedEvidence < full.targetQualifiedContacts) {
      return { status: "WAITING", code: "QUALIFIED_TARGET_NOT_REACHED" };
    }
    if (["APPROVED", "RUNNING"].includes(source.status)) {
      const stopped = await tx.researchPersonSourceApproval.updateMany({
        where: { id: source.id, campaignId: scope.campaignId,
          workspaceId: scope.workspaceId, ownerId: scope.ownerId,
          status: { in: ["APPROVED", "RUNNING"] } },
        data: { status: "TARGET_REACHED" },
      });
      if (stopped.count !== 1) throw new Error("SOURCE_STOP_CAS_CONFLICT");
    }
    const finished = await tx.researchFullRun.updateMany({
      where: { id: full.id, campaignId: scope.campaignId,
        workspaceId: scope.workspaceId, ownerId: scope.ownerId,
        status: "SOURCE_RUNNING" },
      data: { status: "READY_FOR_REVIEW",
        lastCode: "QUALIFIED_TARGET_REACHED" },
    });
    if (finished.count !== 1) throw new Error("FULL_RUN_STOP_CAS_CONFLICT");
    await tx.auditEvent.create({ data: {
      actorId: scope.ownerId, entityId: scope.campaignId,
      action: "research.full-run.qualified-target.reached",
      metadata: { workspaceId: scope.workspaceId,
        qualifiedEvidence: progress.qualifiedEvidence,
        sourceNewPaidClaimsStopped: true,
        contactAccepted: false, sendingEnabled: false },
    } });
    return { status: "READY_FOR_REVIEW", code: "QUALIFIED_TARGET_REACHED",
      qualifiedEvidence: progress.qualifiedEvidence };
  });
}

export async function tickFullRunStages(db, {
  approveTriage = approveEmailTriage,
  enqueue = enqueuePersonSourceJobs,
  approveSource = approvePersonSourceResearch,
  transition = transitionFullRunStage,
  progress = qualifiedFullRunProgress,
  stopAtGoal = stopFullRunSourceAtGoal,
  now = () => new Date(),
} = {}) {
  const clock = now();
  if (!(clock instanceof Date) || !Number.isFinite(clock.getTime()) ||
      [approveTriage, enqueue, approveSource, transition,
        progress, stopAtGoal].some(fn => typeof fn !== "function")) {
    throw new TypeError("Trusted full-run stage controller required");
  }
  const full = await db.researchFullRun.findFirst({
    where: { status: { in: [...ACTIVE_STAGES] } },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
  });
  if (!full) return { status: "IDLE" };
  const scope = { campaignId: full.campaignId,
    workspaceId: full.workspaceId, ownerId: full.ownerId };
  const move = (to, code) => transition(db, scope,
    { from: full.status, to, code, now: clock });
  if (!full.publicInspectionAuthorized ||
      !(full.expiresAt instanceof Date) || full.expiresAt <= clock) {
    return move("NEEDS_REVIEW", "FULL_RUN_APPROVAL_EXPIRED_OR_UNAUTHORIZED");
  }
  const campaign = await db.researchCampaign.findFirst({
    where: { id: scope.campaignId, workspaceId: scope.workspaceId,
      ownerId: scope.ownerId },
    select: { id: true, status: true, emailTriageStatus: true },
  });
  if (!campaign) return move("NEEDS_REVIEW", "CAMPAIGN_NOT_FOUND");
  if (["QUALITY_STOP", "PAUSED_REVIEW"].includes(campaign.status)) {
    return move("NEEDS_REVIEW", "DISCOVERY_REQUIRES_REVIEW");
  }
  if (!TERMINAL_CAMPAIGN.has(campaign.status)) {
    return { status: "WAITING", code: "DISCOVERY_RUNNING" };
  }
  const evidence = await progress(db, scope);
  if (!evidence.reliable) return move("NEEDS_REVIEW", evidence.code);
  if (evidence.qualifiedEvidence >= full.targetQualifiedContacts) {
    return full.status === "SOURCE_RUNNING"
      ? stopAtGoal(db, scope)
      : move("READY_FOR_REVIEW", "QUALIFIED_TARGET_REACHED");
  }
  if (full.status === "DISCOVERY") {
    if (campaign.emailTriageStatus === "RUNNING") {
      return move("EMAIL_TRIAGE", "PREEXISTING_INSPECTION_RUNNING");
    }
    if (campaign.emailTriageStatus === "COMPLETED") {
      return move("SOURCE_PREPARE", "PREEXISTING_INSPECTION_COMPLETED");
    }
    if (campaign.emailTriageStatus !== "IDLE") {
      return move("NEEDS_REVIEW", "EMAIL_TRIAGE_NOT_RESTARTABLE");
    }
    const observations = await db.researchCampaignObservation.count({
      where: { campaignId: scope.campaignId },
    });
    if (observations === 0) return move("PARTIAL", "NO_DISCOVERY_EVIDENCE");
    if (observations > full.maxEmailInspectionPages) {
      return move("NEEDS_REVIEW", "PUBLIC_INSPECTION_PAGE_CAP");
    }
    // The original approval authorized bounded independent public profile
    // reads. Reuse the existing strict source-readiness contract.
    const result = await approveTriage(db, {
      ...scope, maxPages: full.maxEmailInspectionPages,
      confirmPublicInspection: true, confirmSkipUninspectable: true,
    });
    if (result.code === "EMAIL_TRIAGE_APPROVED") {
      return move("EMAIL_TRIAGE", result.code);
    }
    // An all-opaque campaign must go through source resolution, not have
    // individual sources falsely classified as verified or email-free.
    if (["EMAIL_TRIAGE_DIRECT_SOURCE_REQUIRED",
      "EMAIL_TRIAGE_SHARED_SOURCE_REVIEW_REQUIRED"].includes(result.code)) {
      return move("SOURCE_PREPARE", "DISCOVERY_SOURCES_NEED_RESOLUTION");
    }
    return move("NEEDS_REVIEW", result.code ?? "EMAIL_TRIAGE_NOT_AUTHORIZED");
  }
  if (full.status === "EMAIL_TRIAGE") {
    if (campaign.emailTriageStatus === "COMPLETED") {
      return move("SOURCE_PREPARE", "PUBLIC_INSPECTION_COMPLETE");
    }
    if (campaign.emailTriageStatus === "RUNNING") {
      return { status: "WAITING", code: "PUBLIC_INSPECTION_RUNNING" };
    }
    if (campaign.emailTriageStatus === "IDLE") {
      return move("SOURCE_PREPARE", "NO_DIRECT_SOURCES_FOR_INSPECTION");
    }
    return move("NEEDS_REVIEW", "PUBLIC_INSPECTION_NEEDS_RECONCILIATION");
  }
  if (full.status === "SOURCE_PREPARE") {
    const existing = await db.researchPersonSourceApproval.findUnique({
      where: { campaignId: scope.campaignId },
    });
    if (existing) {
      if (existing.workspaceId !== scope.workspaceId ||
          existing.ownerId !== scope.ownerId ||
          existing.provider !== full.provider ||
          existing.model !== full.model ||
          existing.priceVersion !== full.priceVersion ||
          existing.publicInspectionAuthorized !== true) {
        return move("NEEDS_REVIEW", "SOURCE_APPROVAL_MISMATCH");
      }
      return move("SOURCE_RUNNING", "SOURCE_STAGE_ALREADY_APPROVED");
    }
    const queued = await enqueue(db, {
      ...scope, confirmQueuePreparation: true,
    });
    if (queued.status !== 200) {
      return move("NEEDS_REVIEW", queued.code ?? "SOURCE_QUEUE_UNAVAILABLE");
    }
    const jobs = await db.researchPersonSourceJob.count({
      where: { campaignId: scope.campaignId },
    });
    if (!jobs) return move("PARTIAL", "NO_FURTHER_PERSON_SOURCES");
    const setting = await db.aiSetting.findUnique({
      where: { ownerId: scope.ownerId },
      select: { provider: true, model: true },
    });
    if (!setting || setting.provider !== full.provider ||
        setting.model !== full.model) {
      return move("NEEDS_REVIEW", "APPROVED_PROVIDER_CHANGED");
    }
    let price;
    try { price = requireResearchPriceEnvelope(setting); }
    catch { return move("NEEDS_REVIEW", "APPROVED_PRICE_UNAVAILABLE"); }
    if (price.priceVersion !== full.priceVersion ||
        full.maxSourceWorstCaseCents < price.worstCaseCents) {
      return move("NEEDS_REVIEW", "APPROVED_PRICE_CHANGED");
    }
    const maxCalls = Math.min(jobs, full.maxSourceCalls,
      Math.floor(full.maxSourceWorstCaseCents / price.worstCaseCents));
    if (maxCalls < 1) return move("PARTIAL", "SOURCE_BUDGET_EXHAUSTED");
    const approval = await approveSource(db, {
      ...scope,
      input: { maxCalls,
        maxWorstCaseCents: maxCalls * price.worstCaseCents,
        confirmPaidSourceResearch: true,
        confirmNoAutomaticRetry: true,
        confirmPublicInspection: true },
    });
    if (approval.code !== "SOURCE_RUN_APPROVED") {
      return move("NEEDS_REVIEW", approval.code ?? "SOURCE_APPROVAL_FAILED");
    }
    return move("SOURCE_RUNNING", "SOURCE_STAGE_APPROVED_FROM_FULL_RUN");
  }
  if (full.status === "SOURCE_RUNNING") {
    const approval = await db.researchPersonSourceApproval.findUnique({
      where: { campaignId: scope.campaignId },
      select: { status: true, ownerId: true, workspaceId: true },
    });
    if (!approval || approval.ownerId !== scope.ownerId ||
        approval.workspaceId !== scope.workspaceId) {
      return move("NEEDS_REVIEW", "SOURCE_APPROVAL_LOST");
    }
    if (["APPROVED", "RUNNING"].includes(approval.status)) {
      return { status: "WAITING", code: "SOURCE_RESEARCH_RUNNING" };
    }
    if (["COMPLETED", "PARTIAL_BUDGET"].includes(approval.status)) {
      return move("PARTIAL", "QUALIFIED_TARGET_NOT_REACHED");
    }
    return move("NEEDS_REVIEW", "SOURCE_RESEARCH_NEEDS_RECONCILIATION");
  }
  return { status: "BLOCKED", code: "UNKNOWN_FULL_RUN_STAGE" };
}

// The timer only transitions already approved stages. Paid work remains in
// the separate provider executors and their original per-call cost guards.
export function startFullRunStageWorker(db, {
  intervalMs = 8000,
} = {}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 5000 ||
      intervalMs > 60000) throw new TypeError("Invalid full-run poll interval");
  let stopped = false;
  let busy = false;
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try { await tickFullRunStages(db); }
    catch {
      console.warn("[full-run] Stage reconciliation required; no automatic retry");
    } finally { busy = false; }
  };
  const handle = setInterval(() => { void tick(); }, intervalMs);
  return () => { stopped = true; clearInterval(handle); };
}
