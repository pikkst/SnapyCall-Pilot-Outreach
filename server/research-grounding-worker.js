// Process a previously approved grounding claim, never a paid provider call.
// Claims are persisted before any HTTPS HEAD; ambiguous dispatch is not retried.
import { approveGroundingResolution, claimGroundingObservation,
  stopGroundingResolution } from "./research-grounding-run.js";
import { resolveGoogleGroundingLocation } from "./research-grounding-location.js";
import { persistGroundingSourceHint } from "./research-grounding-evidence.js";

export { approveGroundingResolution, stopGroundingResolution };

export async function tickGroundingResolution(db, {
  resolve = resolveGoogleGroundingLocation,
  persist = persistGroundingSourceHint,
  now = () => new Date(),
} = {}) {
  if (typeof resolve !== "function" || typeof persist !== "function" ||
      typeof now !== "function") {
    throw new TypeError("Trusted grounding worker dependencies required");
  }
  const campaign = await db.researchCampaign.findFirst({
    where: { groundingRunStatus: "RUNNING" },
    orderBy: [{ groundingRunApprovedAt: "asc" }, { id: "asc" }],
    select: { id: true, workspaceId: true, ownerId: true },
  });
  if (!campaign) return { status: "IDLE" };
  const scope = { campaignId: campaign.id,
    workspaceId: campaign.workspaceId, ownerId: campaign.ownerId };
  const claim = await claimGroundingObservation(db, scope, { now });
  if (claim.status !== "CLAIMED") return claim;

  // Once claimed, a crash, uncertain network outcome or DB failure retains
  // the lease. The next tick must pause on lease expiry, never replay HEAD.
  let outcome;
  try {
    outcome = await resolve(claim.citationUrl);
  } catch {
    // Resolver exceptions still represent an attempted HTTP dispatch.
    // Record only a sanitized, non-personal status if the lease remains valid.
    outcome = { status: "UNRESOLVED", code: "GROUNDING_REDIRECT_UNAVAILABLE" };
  }
  const saved = await persist(db, {
    ...scope, observationId: claim.observationId,
    originalCitationUrl: claim.citationUrl,
    claimToken: claim.token, outcome,
  }, { now });
  if (saved.status !== 201) {
    return { status: "REVIEW_REQUIRED", code: saved.code };
  }
  return { status: saved.groundingStatus,
    code: saved.code, providerCalls: 0, contactCreated: false,
    sendingEnabled: false };
}

export function startGroundingResolutionWorker(db, {
  intervalMs = 8000, tick = tickGroundingResolution,
} = {}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 5000 ||
      intervalMs > 60_000 || typeof tick !== "function") {
    throw new TypeError("Invalid source resolver interval");
  }
  let busy = false;
  let stopped = false;
  const timer = setInterval(() => {
    if (busy || stopped) return;
    busy = true;
    void tick(db).catch(() => {
      // Never retry the external HEAD after unknown failure. A persisted
      // claim remains until manual resolution of the expired lease.
      console.warn("[grounding] Tick failed; pending lease will not auto-replay");
    }).finally(() => { busy = false; });
  }, intervalMs);
  return () => { stopped = true; clearInterval(timer); };
}

export async function groundingResolutionSummary(db, {
  campaignId, workspaceId, ownerId,
}) {
  const campaign = await db.researchCampaign.findFirst({
    where: { id: campaignId, workspaceId, ownerId },
    select: { id: true, groundingRunStatus: true,
      groundingRunMaxSources: true, groundingRunExpiresAt: true },
  });
  if (!campaign) return null;
  const grouped = await db.researchCampaignObservation.groupBy({
    by: ["groundingStatus"],
    where: { campaignId },
    _count: { id: true },
  });
  const counts = Object.fromEntries(grouped.map(row =>
    [row.groundingStatus, row._count.id]));
  const inFlight = await db.researchCampaignObservation.count({
    where: { campaignId, groundingLeaseToken: { not: null } },
  });
  return Object.freeze({
    status: campaign.groundingRunStatus,
    maxSources: campaign.groundingRunMaxSources,
    expiresAt: campaign.groundingRunExpiresAt,
    remaining: counts.UNCHECKED ?? 0,
    sourceHints: counts.SOURCE_HINT ?? 0,
    unresolved: counts.UNRESOLVED ?? 0,
    rejected: counts.REJECTED ?? 0,
    checking: inFlight,
    verifiedEmails: 0,
    contactsCreated: 0,
    providerCalls: 0,
    sendingEnabled: false,
  });
}
