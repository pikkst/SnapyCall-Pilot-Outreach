// One bounded, explicitly invoked campaign work unit. No background loop.
// All chargeable calls reuse existing BYOK, price, quota, concurrency, spend
// reservation/settlement and workspace-membership contracts.
import { randomUUID } from "node:crypto";
import { claimResearchTask, failResearchTask } from "./research-campaign-leases.js";
import { commitCampaignResearchResult, CampaignLeaseConflict } from "./research-campaign-observations.js";
import { lockActiveWorkspaceMembership, requireWorkspaceMembership } from "./workspace-access.js";
import { lockedResearchPreferences, reserveResearchLease, reserveResearchAttempt,
  releaseResearchLease } from "./research-quota.js";
import { reserveOwnerSpend, settleOwnerSpend } from "./research-budget.js";
import { requireResearchPriceEnvelope, calculateVerifiedSpendCents } from "./research-price-policy.js";
import { assertWebResearchModel } from "./research-provider-adapters.js";
import { researchCandidates, ResearchProviderHttpError } from "./ai-research.js";
import { decryptKey } from "./security.js";

export class ResearchWorkerPreflightError extends Error {
  constructor(code) {
    super("Campaign research worker preflight failed");
    this.name = "ResearchWorkerPreflightError";
    this.code = code;
  }
}

export async function runOneCampaignTask(db, {
  campaignId, workspaceId, ownerId, encryptionKey,
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
    ...scope,
    beforeLock: tx => lockActiveWorkspaceMembership(tx, { workspaceId, userId: ownerId }),
    reserveInTransaction: async (tx, task) => {
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

  try {
    // Membership may have been revoked after the reservation transaction.
    // This is the final authorization gate before the external paid call.
    if (!await membership(db, { workspaceId, userId: ownerId })) {
      await settle(0);
      failure = "PERMISSION_REVOKED";
      return { status: "PAUSED", attempted: false, code: failure };
    }
    // A lease may have expired before this process reaches the provider.
    if (now().getTime() >= claim.leaseUntil.getTime()) {
      await settle(0);
      failure = "BILLING_UNCERTAIN";
      return { status: "PAUSED", attempted: false, code: failure };
    }
    invoked = true;
    const result = await search({
      query: claim.query, limit: claim.limit,
      provider: setting.provider, model: setting.model, apiKey,
    });
    // Billing evidence may be incomplete. The existing policy then charges
    // the full reserved ceiling; never trust model-reported search costs.
    await settle(calculateVerifiedSpendCents(price, result.usage));
    const write = await commitCampaignResearchResult(db, claim, result, now(), {
      beforeCommit: tx => lockActiveWorkspaceMembership(tx, {
        workspaceId, userId: ownerId,
      }),
    });
    return { status: "COMPLETED", attempted: true, taskId: claim.taskId,
      ...write, sendingEnabled: false };
  } catch (error) {
    // Never retry a provider-invoked request automatically: a 429, timeout,
    // transport exception or DB write failure may already be billable.
    failure = !invoked ? "PERMISSION_REVOKED" :
      error instanceof CampaignLeaseConflict ? "PERMISSION_REVOKED" :
      error instanceof ResearchProviderHttpError ? "BILLING_UNCERTAIN" :
      "BILLING_UNCERTAIN";
    return { status: "PAUSED", attempted: invoked, code: failure };
  } finally {
    if (!settled) {
      try { await settle(invoked ? null : 0); }
      catch { /* Preserve unresolved reservation for explicit reconciliation. */ }
    }
    if (failure) {
      try {
        await db.$transaction(tx => failResearchTask(tx, claim, failure, now()));
      } catch { /* Expired lease remains fenced; never automatically replay. */ }
    }
    try { await releaseResearchLease(db, leaseId, workspaceId, ownerId); }
    catch { /* Existing durable concurrency lease expires on its own. */ }
  }
}
