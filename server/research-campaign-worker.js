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
import { requireResearchPriceEnvelope, calculateVerifiedSpendCents,
  calculateVerifiedCombinedSpendCents } from "./research-price-policy.js";
import { assertWebResearchModel, BoundedResearchStageError } from "./research-provider-adapters.js";
import { researchCandidates, researchTavilyGeminiCandidates } from "./ai-research.js";
import { decryptKey } from "./security.js";
import { reserveApprovedRunCall, ApprovedRunBlocked } from "./research-campaign-run-approval.js";

// One settlement decision for the existing campaign worker. This is not a
// dispatch gate: requireResearchPriceEnvelope must already have authorized
// the exact model before claim, reservation, or any provider request.
export function calculateCampaignVerifiedSpendCents({ price, provider, model, usage }) {
  if (price?.billingContractVersion === "tavily-basic-gemini3-text-v1") {
    return provider === "gemini" && model === "gemini-3-flash-preview"
      ? calculateVerifiedCombinedSpendCents(price, usage) : null;
  }
  return calculateVerifiedSpendCents(price, usage);
}

// Validate the server-owned retrieval key and operator entitlement only for
// an ALREADY approved exact-model dual tariff. This is not price approval.
export function resolveCampaignResearchExecution({
  provider, model, price, search = researchCandidates,
  tavilyApiKey, tavilyEnabled, accountCapVerified,
}) {
  if (price?.billingContractVersion !== "tavily-basic-gemini3-text-v1") {
    return Object.freeze({ search, dualProvider: false });
  }
  if (provider !== "gemini" || model !== "gemini-3-flash-preview" ||
      price?.provider !== provider || price?.model !== model ||
      price?.retrievalProvider !== "tavily" ||
      price?.retrieval?.maxRequests !== 1 ||
      price?.textModel?.maxOutputTokens !== 2048 ||
      !Number.isSafeInteger(price?.textModel?.maxInputTokens) ||
      price.textModel.maxInputTokens < 257 ||
      price.textModel.maxInputTokens > 16_384 ||
      price?.enforcementReady !== true) {
    throw new ResearchWorkerPreflightError("DUAL_PROVIDER_PRICE_INVALID");
  }
  // Both values must be provided by the server operator, never a browser.
  // The account cap is an explicit operational prerequisite, not something
  // this software can independently verify with the API.
  if (tavilyEnabled !== true || accountCapVerified !== true ||
      typeof tavilyApiKey !== "string" ||
      !/^tvly-[A-Za-z0-9_-]{8,}$/.test(tavilyApiKey)) {
    throw new ResearchWorkerPreflightError("TAVILY_ACCOUNT_NOT_VERIFIED");
  }
  return Object.freeze({
    search: search === researchCandidates ? researchTavilyGeminiCandidates : search,
    dualProvider: true, tavilyApiKey,
    maxResults: 20,
    maxInputTokens: price.textModel.maxInputTokens,
  });
}

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
  tavilyApiKey = process.env.TAVILY_API_KEY,
  tavilyEnabled = process.env.TAVILY_DUAL_PROVIDER_ENABLED === "true",
  accountCapVerified = process.env.TAVILY_ACCOUNT_CAP_VERIFIED === "true",
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
  const plan = resolveCampaignResearchExecution({
    provider: setting.provider, model: setting.model, price, search,
    tavilyApiKey, tavilyEnabled, accountCapVerified,
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
  let providerReturned = false;
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
      // Persist the possible paid-dispatch boundary BEFORE calling a
      // provider. This is not proof of a charge; it is the durable evidence
      // that an interrupted lease must never be replayed automatically.
      await db.$transaction(tx => tx.auditEvent.create({ data: {
        actorId: ownerId, action: "research.campaign.dispatch.intent",
        entityId: claim.taskId, metadata: {
          campaignId, workspaceId, reservationId,
          provider: setting.provider, model: setting.model,
          dispatchPossible: true, automaticRetryAllowed: false,
        },
      } }));
      invoked = true;
      const result = await plan.search({
        query: claim.query, limit: claim.limit,
        provider: setting.provider, model: setting.model, apiKey,
        ...(plan.dualProvider ? {
          tavilyApiKey: plan.tavilyApiKey,
          maxResults: plan.maxResults,
          maxInputTokens: plan.maxInputTokens,
        } : {}),
      });
      providerReturned = true;
      // Best-effort receipt only; telemetry failure must not turn a valid
      // provider response into another chargeable attempt.
      try {
        await db.$transaction(tx => tx.auditEvent.create({ data: {
          actorId: ownerId, action: "research.campaign.provider.returned",
          entityId: claim.taskId, metadata: {
            campaignId, workspaceId, reservationId,
            provider: setting.provider, responseReturned: true,
            automaticRetryAllowed: false,
          },
        } }));
      } catch {
        console.warn("[research-campaign] Provider receipt audit unavailable");
      }
      // A future reviewed dual-provider policy uses its own complete Tavily
      // + Gemini billing contract. Never apply legacy single-provider tool
      // rates to the combined call. Missing receipts retain the full ceiling.
      await settle(calculateCampaignVerifiedSpendCents({
        price, provider: setting.provider, model: setting.model,
        usage: result.usage,
      }));
      const write = await commitCampaignResearchResult(db, claim, result, now(), {
        beforeCommit: tx => lockActiveWorkspaceMembership(tx, {
          workspaceId, userId: ownerId,
        }),
      });
      outcome = { status: "COMPLETED", attempted: true, taskId: claim.taskId,
        ...write, sendingEnabled: false };
    }
  } catch (error) {
    const verifiedTerminalEvidenceFailure = invoked &&
      setting.provider === "gemini" &&
      ["NO_VERIFIABLE_GROUNDING", "NO_USABLE_STRUCTURED_OUTPUT"].includes(error?.code) &&
      error?.phase === "EVIDENCE_VALIDATION";
    if (verifiedTerminalEvidenceFailure) {
      diagnostic = { code: error.code, phase: "EVIDENCE_VALIDATION" };
      // A terminal provider response with absent citations is a valid
      // zero-evidence result, not a transport outcome to retry. Retain the
      // complete conservative cost because no certified usage survived.
      // Settle before the fenced zero-observation commit. Either failure
      // must preserve the original no-replay PAUSED/reconciliation path.
      try {
        if (!settled) await settle(null);
        const write = await commitCampaignResearchResult(db, claim,
          { candidates: [], sources: [] }, now(), {
            completionCode: diagnostic.code,
            beforeCommit: tx => lockActiveWorkspaceMembership(tx, {
              workspaceId, userId: ownerId,
            }),
          });
        outcome = { status: "COMPLETED", attempted: true,
          taskId: claim.taskId, ...write,
          code: diagnostic.code, sendingEnabled: false };
        // Diagnostic telemetry is best-effort and cannot undo a committed
        // zero-evidence result or cause the paid call to be replayed.
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
      } catch {
        failure = "BILLING_UNCERTAIN";
        outcome = { status: "PAUSED", attempted: true, code: failure,
          diagnosticCode: diagnostic.code };
      }
    } else {
      // Transport failures, incomplete/unknown provider responses and
      // uncertainty after dispatch still require manual reconciliation.
      failure = invoked ? "BILLING_UNCERTAIN" : "UNCLASSIFIED";
      outcome = { status: "PAUSED", attempted: invoked, code: failure };
    }
    // Persist only controlled failure classes, never raw provider errors,
    // prompt text, API keys or model output. These diagnostics distinguish
    // malformed/unfinished responses from charge or DB-commit uncertainty
    // during later operator reconciliation, without authorizing a replay.
    if (invoked && outcome?.status === "PAUSED") {
      const safeReason = providerReturned
        ? "POST_PROVIDER_COMMIT_OR_SETTLEMENT_UNCERTAIN"
        : error?.message === "Gemini search response incomplete"
        ? "GEMINI_RESPONSE_INCOMPLETE"
        : error?.message === "Gemini search returned no structured response"
        ? "GEMINI_RESPONSE_MALFORMED"
        : error?.message === "AI research did not return structured results" ||
          error?.message === "AI research returned an invalid candidate list"
        ? "CITED_OUTPUT_INVALID"
        : error?.name === "AbortError"
        ? "UPSTREAM_ABORTED"
        : "UPSTREAM_DISPATCH_UNCERTAIN";
      // Only the locally constructed adapter error may supply a phase.
      // Never accept a provider-supplied or forged stage from arbitrary JSON.
      const trustedDualStage = setting.provider === "gemini" &&
        setting.model === "gemini-3-flash-preview" &&
        error instanceof BoundedResearchStageError &&
        [
          "TAVILY_SEARCH_DISPATCHED",
          "GEMINI_INPUT_PREPARATION",
          "GEMINI_COUNT_TOKENS_DISPATCHED",
          "GEMINI_GENERATE_CONTENT_DISPATCHED",
          "GEMINI_UNKNOWN_DISPATCH",
        ].includes(error.stage) ? error.stage : null;
      try {
        await db.auditEvent.create({ data: {
          actorId: ownerId, action: "research.campaign.execution.paused",
          entityId: claim.taskId,
          metadata: { workspaceId, campaignId, provider: setting.provider,
            code: "BILLING_UNCERTAIN", safeReason,
            ...(trustedDualStage ? { dualProviderStage: trustedDualStage } : {}),
            billedCallPossible: true, automaticRetryAllowed: false },
        } });
      } catch {
        console.warn("[research-campaign] Sanitized pause diagnostic unavailable");
      }
    }
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
