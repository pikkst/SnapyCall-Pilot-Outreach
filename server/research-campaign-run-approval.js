// A durable, immutable approval envelope for at most 250 independently
// metered campaign research calls. User approval never authorizes sending.
import { lockActiveWorkspaceMembership } from "./workspace-access.js";
import { requireResearchPriceEnvelope } from "./research-price-policy.js";
import { validateFullRunScope } from "./research-full-run-contract.js";

const CUID = /^c[a-z0-9]{10,40}$/;
const APPROVAL_LIFETIME_MS = 24 * 60 * 60 * 1000;
export class ApprovedRunBlocked extends Error {
  constructor(code) {
    super("Approved campaign execution halted");
    this.name = "ApprovedRunBlocked";
    this.code = code;
  }
}

export function validateCampaignRunApproval(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(k => !["maxTasks", "maxWorstCaseCents",
        "confirmConservativeBudget", "confirmNoAutomaticRetry"].includes(k)) ||
      !Number.isInteger(value.maxTasks) || value.maxTasks < 1 ||
      value.maxTasks > 250 || !Number.isSafeInteger(value.maxWorstCaseCents) ||
      value.maxWorstCaseCents < 1 || value.maxWorstCaseCents > 50000 ||
      value.confirmConservativeBudget !== true ||
      value.confirmNoAutomaticRetry !== true) {
    throw new TypeError("Explicit run authorization, risk acceptance and limits required");
  }
  return Object.freeze({
    maxTasks: value.maxTasks, maxWorstCaseCents: value.maxWorstCaseCents,
  });
}

export async function approveCampaignRun(db, {
  campaignId, workspaceId, ownerId, input,
}) {
  if (![campaignId, workspaceId, ownerId].every(id =>
      typeof id === "string" && CUID.test(id))) {
    throw new TypeError("Valid campaign owner scope required");
  }
  // A new full-run charter is one optional scope on the existing approval
  // API. Legacy discovery approvals remain strict and unchanged.
  const fullRequested = input && Object.prototype.hasOwnProperty.call(input, "fullRun");
  const discoveryInput = fullRequested ? Object.fromEntries(
    Object.entries(input).filter(([key]) => key !== "fullRun")) : input;
  const limits = validateCampaignRunApproval(discoveryInput);
  const setting = await db.aiSetting.findUnique({ where: { ownerId },
    select: { provider: true, model: true } });
  if (!setting) return { status: 409, code: "RESEARCH_AI_SETTINGS_REQUIRED" };
  // Policy is checked again at execution before every reservation.
  const price = requireResearchPriceEnvelope(setting);
  if (limits.maxWorstCaseCents < price.worstCaseCents ||
      limits.maxWorstCaseCents > limits.maxTasks * price.worstCaseCents) {
    return { status: 409, code: "RUN_PRICE_ENVELOPE_INVALID" };
  }
  const fullRun = fullRequested ? validateFullRunScope(
    input.fullRun, limits, price) : null;
  return db.$transaction(async tx => {
    if (!await lockActiveWorkspaceMembership(tx, { workspaceId, userId: ownerId })) {
      return { status: 403, code: "WORKSPACE_ACCESS_REVOKED" };
    }
    // Lock order matches the existing claim path (membership, campaign).
    const campaigns = await tx.$queryRaw`
      SELECT "id","status" FROM "ResearchCampaign"
      WHERE "id" = ${campaignId} AND "workspaceId" = ${workspaceId}
        AND "ownerId" = ${ownerId} FOR UPDATE`;
    if (campaigns.length !== 1) return { status: 404, code: "CAMPAIGN_NOT_FOUND" };
    const prior = await tx.researchCampaignRun.findUnique({ where: { campaignId } });
    if (prior && fullRun) {
      const full = await tx.researchFullRun.findUnique({ where: { campaignId } });
      const identical = full && full.workspaceId === workspaceId &&
        full.ownerId === ownerId &&
        full.provider === setting.provider && full.model === setting.model &&
        full.priceVersion === price.priceVersion &&
        full.maxDiscoveryCalls === limits.maxTasks &&
        full.maxDiscoveryWorstCaseCents === limits.maxWorstCaseCents &&
        full.maxSourceCalls === fullRun.maxSourceCalls &&
        full.maxEmailInspectionPages === fullRun.maxEmailInspectionPages &&
        full.maxTotalWorstCaseCents === fullRun.maxTotalWorstCaseCents &&
        full.publicInspectionAuthorized === true;
      return identical ? { status: 200, code: "FULL_RUN_ALREADY_APPROVED",
        run: publicRunStatus(prior), fullRun: publicFullRunStatus(full) }
        : { status: 409, code: "RUN_APPROVAL_IMMUTABLE" };
    }
    if (prior) {
      const identical = prior.workspaceId === workspaceId &&
        prior.ownerId === ownerId && prior.provider === setting.provider &&
        prior.model === setting.model && prior.priceVersion === price.priceVersion &&
        prior.maxTasks === limits.maxTasks &&
        prior.maxWorstCaseCents === limits.maxWorstCaseCents;
      return identical
        ? { status: 200, code: "RUN_APPROVAL_ALREADY_EXISTS",
          run: publicRunStatus(prior) }
        : { status: 409, code: "RUN_APPROVAL_IMMUTABLE" };
    }
    if (!["QUEUED", "RUNNING"].includes(campaigns[0].status)) {
      return { status: 409, code: "CAMPAIGN_NOT_EXECUTABLE" };
    }
    // Only a clean, not-yet-executed campaign can gain autonomous spending
    // authorization. Existing 101 observations are never silently replayed.
    const [attempts, observations] = await Promise.all([
      tx.researchCampaignTask.count({ where: {
        campaignId, OR: [{ attempts: { gt: 0 } }, { status: { not: "QUEUED" } }],
      } }),
      tx.researchCampaignObservation.count({ where: { campaignId } }),
    ]);
    if (attempts !== 0 || observations !== 0) {
      return { status: 409, code: "CAMPAIGN_ALREADY_STARTED" };
    }
    const created = await tx.researchCampaignRun.create({ data: {
      campaignId, workspaceId, ownerId,
      provider: setting.provider, model: setting.model,
      priceVersion: price.priceVersion, worstCasePerCallCents: price.worstCaseCents,
      maxTasks: limits.maxTasks, maxWorstCaseCents: limits.maxWorstCaseCents,
      expiresAt: new Date(Date.now() + APPROVAL_LIFETIME_MS),
    } });
    let createdFullRun = null;
    if (fullRun) {
      const campaign = await tx.researchCampaign.findUnique({
        where: { id: campaignId }, select: { targetCount: true },
      });
      if (!campaign || !Number.isInteger(campaign.targetCount) ||
          campaign.targetCount < 20 || campaign.targetCount > 200) {
        throw new TypeError("Valid saved campaign target required");
      }
      createdFullRun = await tx.researchFullRun.create({ data: {
        campaignId, workspaceId, ownerId,
        provider: setting.provider, model: setting.model,
        priceVersion: price.priceVersion,
        targetQualifiedContacts: campaign.targetCount,
        maxDiscoveryCalls: limits.maxTasks,
        maxSourceCalls: fullRun.maxSourceCalls,
        maxEmailInspectionPages: fullRun.maxEmailInspectionPages,
        maxDiscoveryWorstCaseCents: limits.maxWorstCaseCents,
        maxSourceWorstCaseCents: fullRun.maxSourceWorstCaseCents,
        maxTotalWorstCaseCents: fullRun.maxTotalWorstCaseCents,
        publicInspectionAuthorized: true,
        expiresAt: created.expiresAt,
      } });
    }
    await tx.auditEvent.create({ data: {
      actorId: ownerId, action: "research.campaign.run.approved",
      entityId: campaignId, metadata: {
        workspaceId, runId: created.id,
        maxTasks: limits.maxTasks, maxWorstCaseCents: limits.maxWorstCaseCents,
        provider: setting.provider, model: setting.model,
        priceVersion: price.priceVersion,
        sendingEnabled: false, automaticBillableReplay: false,
        ...(createdFullRun ? {
          fullRunId: createdFullRun.id,
          sourceCallCeiling: fullRun.maxSourceCalls,
          totalWorstCaseCents: fullRun.maxTotalWorstCaseCents,
          publicInspectionAuthorized: true,
          contactAcceptanceAuthorized: false,
        } : {}),
      },
    } });
    return { status: 201,
      code: createdFullRun ? "FULL_RUN_APPROVED" : "RUN_APPROVED",
      run: publicRunStatus(created),
      ...(createdFullRun ? { fullRun: publicFullRunStatus(createdFullRun) } : {}) };
  });
}

export function publicFullRunStatus(run) {
  if (!run) return null;
  return Object.freeze({
    status: run.status, targetQualifiedContacts: run.targetQualifiedContacts,
    maxDiscoveryCalls: run.maxDiscoveryCalls,
    maxSourceCalls: run.maxSourceCalls,
    maxEmailInspectionPages: run.maxEmailInspectionPages,
    maxTotalWorstCaseCents: run.maxTotalWorstCaseCents,
    maxSourceWorstCaseCents: run.maxSourceWorstCaseCents,
    lastCode: run.lastCode, expiresAt: run.expiresAt,
    contactAcceptanceAuthorized: false, sendingEnabled: false,
  });
}

export function publicRunStatus(run) {
  return Object.freeze({
    id: run.id, status: run.status, maxTasks: run.maxTasks,
    startedTasks: run.startedTasks,
    maxWorstCaseCents: run.maxWorstCaseCents,
    committedWorstCaseCents: run.committedWorstCaseCents,
    lastCode: run.lastCode, expiresAt: run.expiresAt,
    sendingEnabled: false,
  });
}

// Called INSIDE claimResearchTask's campaign-row-locked transaction, before
// monthly budget/quota reservation and before any provider dispatch.
export async function reserveApprovedRunCall(tx, {
  campaignId, workspaceId, ownerId, provider, model, price,
}) {
  const run = await tx.researchCampaignRun.findUnique({ where: { campaignId } });
  if (!run || run.workspaceId !== workspaceId || run.ownerId !== ownerId ||
      !["APPROVED", "RUNNING"].includes(run.status)) {
    throw new ApprovedRunBlocked("RUN_NOT_APPROVED");
  }
  if (!(run.expiresAt instanceof Date) ||
      run.expiresAt.getTime() <= Date.now()) {
    throw new ApprovedRunBlocked("RUN_APPROVAL_EXPIRED");
  }
  if (run.provider !== provider || run.model !== model ||
      run.priceVersion !== price.priceVersion ||
      run.worstCasePerCallCents !== price.worstCaseCents) {
    throw new ApprovedRunBlocked("RUN_PRICE_OR_MODEL_CHANGED");
  }
  const active = await tx.researchCampaignTask.count({
    where: { campaignId, status: "RUNNING" },
  });
  if (active) throw new ApprovedRunBlocked("RUN_TASK_ALREADY_IN_FLIGHT");
  if (run.startedTasks >= run.maxTasks ||
      run.committedWorstCaseCents + price.worstCaseCents >
        run.maxWorstCaseCents) {
    throw new ApprovedRunBlocked("RUN_LIMIT_REACHED");
  }
  const updated = await tx.researchCampaignRun.updateMany({
    where: { id: run.id, campaignId, workspaceId, ownerId,
      status: { in: ["APPROVED", "RUNNING"] },
      expiresAt: { gt: new Date() },
      startedTasks: { lt: run.maxTasks },
      committedWorstCaseCents: { lte:
        run.maxWorstCaseCents - price.worstCaseCents } },
    data: { status: "RUNNING", startedTasks: { increment: 1 },
      committedWorstCaseCents: { increment: price.worstCaseCents } },
  });
  if (updated.count !== 1) throw new ApprovedRunBlocked("RUN_APPROVAL_CHANGED");
}

// A result does not release worst-case commitments. Only an independent
// verified cost ledger determines actual monthly spend or provider invoice.
export async function finishApprovedRunTask(db, {
  campaignId, workspaceId, ownerId, result,
}) {
  return db.$transaction(async tx => {
    if (!await lockActiveWorkspaceMembership(tx, { workspaceId, userId: ownerId })) {
      return { code: "WORKSPACE_ACCESS_REVOKED" };
    }
    const campaigns = await tx.$queryRaw`
      SELECT "id","status" FROM "ResearchCampaign"
      WHERE "id" = ${campaignId} AND "workspaceId" = ${workspaceId}
        AND "ownerId" = ${ownerId} FOR UPDATE`;
    if (campaigns.length !== 1) return { code: "CAMPAIGN_NOT_FOUND" };
    const run = await tx.researchCampaignRun.findUnique({ where: { campaignId } });
    if (!run || run.workspaceId !== workspaceId || run.ownerId !== ownerId ||
        !["RUNNING", "APPROVED"].includes(run.status)) {
      return { code: "RUN_NOT_ACTIVE" };
    }
    const qualityStopped = campaigns[0].status === "QUALITY_STOP";
    const terminal = ["COMPLETED", "PARTIAL", "CANCELLED"].includes(campaigns[0].status);
    // The workspace dispatch gate rejected this tick before any monetary
    // reservation or upstream call. Preserve the original immutable approval
    // and let the existing worker revisit it after the DB-enforced interval.
    const pacingWaiting = result?.status === "RATE_LIMIT_WAIT" &&
      !terminal && run.expiresAt instanceof Date &&
      run.expiresAt.getTime() > Date.now() &&
      run.startedTasks < run.maxTasks &&
      run.committedWorstCaseCents + run.worstCasePerCallCents <=
        run.maxWorstCaseCents;
    // A queued task waiting for an already scheduled, bounded retry is not
    // a failed campaign. Never require a fresh user approval merely because
    // the tick found no task eligible at this exact instant.
    let retryWaiting = false;
    if (result?.status === "NO_READY_TASK" && !terminal &&
        run.expiresAt instanceof Date && run.expiresAt.getTime() > Date.now() &&
        run.startedTasks < run.maxTasks &&
        run.committedWorstCaseCents + run.worstCasePerCallCents <=
          run.maxWorstCaseCents) {
      const unresolved = await tx.researchCampaignTask.count({
        where: { campaignId, status: { in: ["PAUSED", "FAILED", "RUNNING"] } },
      });
      if (unresolved === 0) {
        const next = await tx.researchCampaignTask.findFirst({
          where: { campaignId, status: "QUEUED", attempts: { lt: 3 },
            nextAttemptAt: { gt: new Date() } },
          select: { id: true },
        });
        retryWaiting = next !== null;
      }
    }
    // A bounded run can exhaust its immutable paid approval before the
    // 100-candidate target, leaving queued tasks that can NEVER be dispatched
    // under this approval. Finalize the campaign as PARTIAL only after the
    // last task completed successfully and there is no other in-flight task.
    // This makes the saved evidence eligible for independently approved
    // read-only email inspection without replaying any provider calls.
    const limitExhausted = result?.status === "COMPLETED" &&
      campaigns[0].status === "RUNNING" &&
      (run.startedTasks >= run.maxTasks ||
       run.committedWorstCaseCents + run.worstCasePerCallCents >
         run.maxWorstCaseCents);
    let boundedPartial = false;
    if (limitExhausted) {
      const inFlight = await tx.researchCampaignTask.count({
        where: { campaignId, status: "RUNNING" },
      });
      if (inFlight === 0) {
        const saved = await tx.researchCampaign.updateMany({
          where: { id: campaignId, workspaceId, ownerId, status: "RUNNING" },
          data: { status: "PARTIAL" },
        });
        boundedPartial = saved.count === 1;
        if (boundedPartial) {
          await tx.auditEvent.create({ data: {
            actorId: ownerId, action: "research.campaign.finalized",
            entityId: campaignId, metadata: {
              workspaceId, status: "PARTIAL",
              reason: "IMMUTABLE_APPROVED_RUN_LIMIT_REACHED",
              approvedCalls: run.maxTasks, startedCalls: run.startedTasks,
              committedWorstCaseCents: run.committedWorstCaseCents,
              automaticBillableReplay: false, sendingEnabled: false,
            },
          } });
        }
      }
    }
    const status = qualityStopped ? "PAUSED" :
      boundedPartial || (["COMPLETED", "NO_READY_TASK"].includes(result?.status) &&
      terminal) ? "COMPLETED" :
      (result?.status === "COMPLETED" || retryWaiting || pacingWaiting) &&
      run.startedTasks < run.maxTasks &&
      run.expiresAt instanceof Date && run.expiresAt.getTime() > Date.now() &&
      run.committedWorstCaseCents + run.worstCasePerCallCents <=
        run.maxWorstCaseCents ? "RUNNING" : "PAUSED";
    const code = qualityStopped ? "QUALITY_STOP" :
      boundedPartial ? "RUN_LIMIT_REACHED" :
      status === "COMPLETED" ? "CAMPAIGN_FINISHED" :
      status === "RUNNING" ? (pacingWaiting ? "WAITING_RATE_LIMIT" :
        retryWaiting ? "WAITING_RETRY" : null) :
      result?.status === "COMPLETED" ? "RUN_LIMIT_REACHED" :
      result?.code ?? result?.status ?? "RUN_OUTCOME_UNCERTAIN";
    await tx.researchCampaignRun.update({
      where: { id: run.id }, data: { status, lastCode: code },
    });
    return { code: status, lastCode: code };
  });
}

// Catch paths must preserve the no-replay invariant even when the provider
// may have billed and the transport outcome is unavailable.
export async function pauseApprovedRun(db, {
  campaignId, workspaceId, ownerId, code,
}) {
  const allow = new Set(["RUN_PREFLIGHT_BLOCKED", "RUN_EXECUTION_UNCERTAIN",
    "RUN_NO_READY_TASK", "RUN_PRICE_OR_MODEL_CHANGED",
    "RUN_APPROVAL_EXPIRED"]);
  const lastCode = allow.has(code) ? code : "RUN_EXECUTION_UNCERTAIN";
  await db.researchCampaignRun.updateMany({
    where: { campaignId, workspaceId, ownerId,
      status: { in: ["APPROVED", "RUNNING"] } },
    data: { status: "PAUSED", lastCode },
  });
}

export async function stopApprovedCampaignRun(db, {
  campaignId, workspaceId, ownerId,
}) {
  if (![campaignId, workspaceId, ownerId].every(id =>
      typeof id === "string" && CUID.test(id))) {
    throw new TypeError("Valid campaign stop scope required");
  }
  return db.$transaction(async tx => {
    if (!await lockActiveWorkspaceMembership(tx, { workspaceId, userId: ownerId })) {
      return { status: 403, code: "WORKSPACE_ACCESS_REVOKED" };
    }
    const rows = await tx.$queryRaw`
      SELECT "id" FROM "ResearchCampaign"
      WHERE "id" = ${campaignId} AND "workspaceId" = ${workspaceId}
        AND "ownerId" = ${ownerId} FOR UPDATE`;
    if (rows.length !== 1) return { status: 404, code: "CAMPAIGN_NOT_FOUND" };
    const run = await tx.researchCampaignRun.findUnique({ where: { campaignId } });
    if (!run || run.workspaceId !== workspaceId || run.ownerId !== ownerId) {
      return { status: 404, code: "RUN_NOT_FOUND" };
    }
    const charter = await tx.researchFullRun.findUnique({
      where: { campaignId },
    });
    if (charter && (charter.ownerId !== ownerId ||
        charter.workspaceId !== workspaceId)) {
      return { status: 403, code: "FULL_RUN_SCOPE_MISMATCH" };
    }
    const fullActive = charter && ["DISCOVERY", "EMAIL_TRIAGE",
      "SOURCE_PREPARE", "SOURCE_RUNNING"].includes(charter.status);
    const discoveryActive = ["APPROVED", "RUNNING"].includes(run.status);
    if (!fullActive && !discoveryActive) {
      return { status: 200, code: "RUN_ALREADY_TERMINAL",
        run: publicRunStatus(run) };
    }
    // All staged claims acquire the same campaign lock. A stop revokes new
    // paid starts and further page inspections atomically across stages.
    if (fullActive) {
      const stopped = await tx.researchFullRun.updateMany({
        where: { id: charter.id, campaignId, workspaceId, ownerId,
          status: { in: ["DISCOVERY", "EMAIL_TRIAGE",
            "SOURCE_PREPARE", "SOURCE_RUNNING"] } },
        data: { status: "STOPPED", lastCode: "USER_STOPPED" },
      });
      if (stopped.count !== 1) throw new Error("FULL_RUN_STOP_CAS_CONFLICT");
      await tx.researchPersonSourceApproval.updateMany({
        where: { campaignId, workspaceId, ownerId,
          status: { in: ["APPROVED", "RUNNING"] } },
        data: { status: "STOPPED" },
      });
      await tx.researchCampaign.updateMany({
        where: { id: campaignId, workspaceId, ownerId,
          emailTriageStatus: "RUNNING" },
        data: { emailTriageStatus: "PAUSED" },
      });
    }
    let saved = run;
    if (discoveryActive) {
      saved = await tx.researchCampaignRun.update({
        where: { id: run.id }, data: {
          status: "PAUSED", lastCode: "USER_STOPPED",
        },
      });
    }
    await tx.auditEvent.create({ data: {
      actorId: ownerId, action: "research.campaign.run.stopped",
      entityId: campaignId, metadata: {
        workspaceId, runId: run.id,
        fullRunStopped: !!fullActive,
        futureSourceCallsStopped: !!fullActive,
        inFlightMayStillBeBilled: true, automaticRetryAllowed: false,
        sendingEnabled: false,
      },
    } });
    return { status: 200, code: "RUN_STOPPED",
      run: publicRunStatus(saved),
      fullRun: charter
        ? { ...publicFullRunStatus(charter),
            status: fullActive ? "STOPPED" : charter.status,
            lastCode: fullActive ? "USER_STOPPED" : charter.lastCode }
        : null,
      fullRunStopped: !!fullActive, sendingEnabled: false };
  });
}
