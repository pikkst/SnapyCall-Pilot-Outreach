// One bounded, explicitly invoked campaign work unit. No background loop.
// All chargeable calls reuse existing BYOK, price, quota, concurrency, spend
// reservation/settlement and workspace-membership contracts.
import { randomUUID } from "node:crypto";
import { claimResearchTask, failResearchTask } from "./research-campaign-leases.js";
import { commitCampaignResearchResult } from "./research-campaign-observations.js";
import { lockActiveWorkspaceMembership, requireWorkspaceMembership } from "./workspace-access.js";
import { lockedResearchPreferences, reserveResearchLease, reserveResearchAttempt,
  releaseResearchLease } from "./research-quota.js";
import { reserveOwnerSpend, settleOwnerSpend } from "./research-budget.js";
import { requireResearchPriceEnvelope, calculateVerifiedSpendCents } from "./research-price-policy.js";
import { assertWebResearchModel } from "./research-provider-adapters.js";
import { researchCandidates } from "./ai-research.js";
import { decryptKey } from "./security.js";
import { reserveApprovedRunCall, ApprovedRunBlocked } from "./research-campaign-run-approval.js";

export class ResearchWorkerPreflightError extends Error {
  constructor(code) {
    super("Campaign research worker preflight failed");
    this.name = "ResearchWorkerPreflightError";
    this.code = code;
  }
}

export async function runOneCampaignTask(db, {
  campaignId, workspaceId, ownerId, encryptionKey,
  autonomousApproved = false,
}, {
  search = researchCandidates, now = () => new Date(),
  membership = requireWorkspaceMembership,
  decrypt = decryptKey,
} = {}) {
  // Callers must require an explicit server-side feature flag and active,
  // authenticated partner scope before invoking this executor.
  if ([campaignId, workspaceId, ownerId].some(id =>
    typeof id !== "string" || !/^c[a-z0-9]{10,40}$/.test(id)) ||
    typeof encryptionKey !== "string" || encryptionKey.length < 16 ||
    typeof search !== "function" || typeof membership !== "function" ||
    typeof decrypt !== "function" || typeof now !== "function") {
    throw new TypeError("Verified owner, workspace and worker configuration required");
  }
  const setting = await db.aiSetting.findUnique({ where: { ownerId } });
  if (!setting || !["anthropic", "openai", "gemini"].includes(setting.provider)) {
    throw new ResearchWorkerPreflightError("RESEARCH_AI_SETTINGS_REQUIRED");
  }
  if (setting.provider !== "anthropic") {
    try { assertWebResearchModel(setting.provider, setting.model); }
    catch { throw new ResearchWorkerPreflightError("RESEARCH_MODEL_UNSUPPORTED"); }
  }
  const price = requireResearchPriceEnvelope({
    provider: setting.provider, model: setting.model,
  });
  let apiKey;
  try { apiKey = decrypt(setting.encryptedApiKey, encryptionKey); }
  catch { throw new ResearchWorkerPreflightError("RESEARCH_KEY_UNAVAILABLE"); }
  if (typeof apiKey !== "string" || apiKey.length < 8) {
    throw new ResearchWorkerPreflightError("RESEARCH_KEY_UNAVAILABLE");
  }

  const scope = { campaignId, workspaceId, ownerId };
  const claim = await claimResearchTask(db, {
    ...scope, now: now(),
    beforeLock: tx => lockActiveWorkspaceMembership(tx, { workspaceId, userId: ownerId }),
    reserveInTransaction: async (tx, task) => {
      // Existing explicit executor cannot spend against an autonomous approval.
      // Campaign and membership rows are already locked by claimResearchTask.
      if (autonomousApproved) {
        await reserveApprovedRunCall(tx, {
          campaignId, workspaceId, ownerId,
          provider: setting.provider, model: setting.model, price,
        });
      } else {
        const priorRun = await tx.researchCampaignRun.findUnique({
          where: { campaignId }, select: { id: true },
        });
        if (priorRun) throw new ApprovedRunBlocked("RUN_REQUIRES_AUTONOMOUS_EXECUTOR");
      }
      const preferences = await lockedResearchPreferences(tx, ownerId);
      if (task.limit > preferences.maxCandidates) {
        throw new ResearchWorkerPreflightError("RESEARCH_RESULT_LIMIT_EXCEEDED");
      }
      const leaseId = await reserveResearchLease(tx, {
        workspaceId, userId: ownerId, maxConcurrent: preferences.maxConcurrent,
      });
      const reservationId = randomUUID();
      await reserveOwnerSpend(tx, { ownerId, workspaceId, reservationId,
        worstCaseCents: price.worstCaseCents });
      await reserveResearchAttempt(tx, { workspaceId, userId: ownerId,
        dailyLimit: preferences.dailyLimit });
      await tx.auditEvent.create({ data: {
        actorId: ownerId, action: "research.campaign.spend.reserved",
        entityId: reservationId, metadata: { workspaceId, campaignId,
          taskId: task.taskId, provider: setting.provider, model: setting.model,
          priceVersion: price.priceVersion, worstCaseCents: price.worstCaseCents },
      } });
      return { leaseId, reservationId };
    },
  });
  if (!claim) return { status: "NO_READY_TASK", attempted: false };
  const { leaseId, reservationId } = claim.reservation;
  let settled = false;
  let invoked = false;
  let failure = null;
  let diagnostic = null;

  const settle = async cents => {
    await db.$transaction(async tx => {
      await settleOwnerSpend(tx, { ownerId, workspaceId, reservationId,
        actualCents: cents });
      await tx.auditEvent.create({ data: {
        actorId: ownerId, action: "research.campaign.spend.settled",
        entityId: reservationId, metadata: { workspaceId, campaignId,
          taskId: claim.taskId, chargedCents: cents ?? price.worstCaseCents,
          conservative: cents === null },
      } });
    });
    settled = true;
  };

  let outcome;
  let reconciliationRequired = false;
  try {
    // Membership may have been revoked after the reservation transaction.
    // This is the final authorization gate before the external paid call.
    if (!await membership(db, { workspaceId, userId: ownerId })) {
      await settle(0);
      failure = "PERMISSION_REVOKED";
      outcome = { status: "PAUSED", attempted: false, code: failure };
    } else if (now().getTime() >= claim.leaseUntil.getTime()) {
      // No upstream call was made. Fail closed without charging provider funds.
      await settle(0);
      failure = "UNCLASSIFIED";
      outcome = { status: "PAUSED", attempted: false, code: failure };
    } else {
      invoked = true;
      const result = await search({
        query: claim.query, limit: claim.limit,
        provider: setting.provider, model: setting.model, apiKey,
      });
      // Missing certified billing evidence keeps the full reserved ceiling.
      await settle(calculateVerifiedSpendCents(price, result.usage));
      const write = await commitCampaignResearchResult(db, claim, result, now(), {
        beforeCommit: tx => lockActiveWorkspaceMembership(tx, {
          workspaceId, userId: ownerId,
        }),
      });
      outcome = { status: "COMPLETED", attempted: true, taskId: claim.taskId,
        ...write, sendingEnabled: false };
    }
  } catch (error) {
    // A provider can bill for a completed answer lacking grounding. Keep
    // BILLING_UNCERTAIN as the conservative lease/budget state; record only
    // a stable, allow-listed diagnostic code for human reconciliation.
    if (invoked && error?.code === "NO_VERIFIABLE_GROUNDING" &&
        error?.phase === "EVIDENCE_VALIDATION") {
      diagnostic = { code: "NO_VERIFIABLE_GROUNDING",
        phase: "EVIDENCE_VALIDATION" };
    }
    failure = invoked ? "BILLING_UNCERTAIN" : "UNCLASSIFIED";
    outcome = { status: "PAUSED", attempted: invoked, code: failure,
      ...(diagnostic ? { diagnosticCode: diagnostic.code } : {}) };
  } finally {
    if (!settled) {
      try { await settle(invoked ? null : 0); }
      catch {
        // Preserve unresolved reservation. A subsequent reconciliation must
        // inspect the ledger instead of assuming that settlement succeeded.
        reconciliationRequired = true;
        console.warn("[research-campaign] Spend reservation needs reconciliation");
      }
    }
    if (failure) {
      try {
        const state = await db.$transaction(tx =>
          failResearchTask(tx, claim, failure, now()));
        if (!state.applied) {
          outcome = { status: "RECOVERY_REQUIRED", attempted: invoked,
            code: "TASK_LEASE_STATE_UNCONFIRMED" };
        } else if (diagnostic) {
          // Non-critical audit: a telemetry outage must never undo the PAUSED
          // lease or cause another potentially billable provider request.
          try {
            await db.auditEvent.create({ data: {
              actorId: ownerId,
              action: "research.campaign.evidence.rejected",
              entityId: claim.taskId,
              metadata: { workspaceId, campaignId,
                phase: diagnostic.phase, code: diagnostic.code,
                provider: setting.provider, billedCallPossible: true,
                automaticRetryAllowed: false },
            } });
          } catch {
            console.warn("[research-campaign] Sanitized diagnostic audit unavailable");
          }
        }
      } catch {
        outcome = { status: "RECOVERY_REQUIRED", attempted: invoked,
          code: "TASK_LEASE_STATE_UNCONFIRMED" };
      }
    }
    try { await releaseResearchLease(db, leaseId, workspaceId, ownerId); }
    catch {
      console.warn("[research-campaign] Concurrency lease will expire automatically");
    }
  }
  if (reconciliationRequired) {
    return { status: "RECONCILIATION_REQUIRED", attempted: invoked,
      code: "RESEARCH_SPEND_RECONCILIATION_REQUIRED" };
  }
  return outcome;
}
