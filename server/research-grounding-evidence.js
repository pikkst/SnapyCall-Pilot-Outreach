// Persist a previously resolved Google grounding header as a source hint.
// This function NEVER performs network access, creates contacts or authorizes
// email triage; the original provider citation remains immutable.
import { lockActiveWorkspaceMembership, isWorkspaceId }
  from "./workspace-access.js";
import { publicCitationUrl } from "./research-evidence.js";
import { isGoogleGroundingCitation } from "./research-grounding-location.js";

const OBSERVATION_ID = /^c[a-z0-9]{10,40}$/;
const FAILURE_CODES = new Set([
  "NOT_GOOGLE_GROUNDING_CITATION",
  "GROUNDING_REDIRECT_UNAVAILABLE",
  "GROUNDING_LOCATION_NOT_AVAILABLE",
  "GROUNDING_DESTINATION_INVALID",
  "GROUNDING_DESTINATION_DNS_REJECTED",
]);

export function validateGroundingOutcome(citationUrl, outcome) {
  const citation = publicCitationUrl(citationUrl);
  if (!citation || !isGoogleGroundingCitation(citation) ||
      !outcome || typeof outcome !== "object" || Array.isArray(outcome)) {
    throw new TypeError("A valid provider grounding outcome is required");
  }
  if (outcome.status === "SOURCE_HINT") {
    const url = publicCitationUrl(outcome.sourceUrl);
    if (!url || url !== outcome.sourceUrl ||
        outcome.citationUrl !== citation ||
        outcome.provenance !== "GOOGLE_GROUNDING_LOCATION_HEADER" ||
        outcome.identityVerified !== false ||
        outcome.emailVerified !== false ||
        outcome.contactCreated !== false || outcome.sendingEnabled !== false ||
        new URL(url).hostname === "vertexaisearch.cloud.google.com") {
      throw new TypeError("Untrusted or inconsistent grounding source hint");
    }
    return Object.freeze({
      groundingStatus: "SOURCE_HINT", groundingResolvedUrl: url,
      groundingProvenance: "GOOGLE_GROUNDING_LOCATION_HEADER",
      groundingCode: null,
    });
  }
  if (["REJECTED", "UNRESOLVED"].includes(outcome.status) &&
      FAILURE_CODES.has(outcome.code) &&
      outcome.code !== "NOT_GOOGLE_GROUNDING_CITATION") {
    return Object.freeze({
      groundingStatus: outcome.status, groundingResolvedUrl: null,
      groundingProvenance: null, groundingCode: outcome.code,
    });
  }
  throw new TypeError("Unsupported grounding outcome");
}

export async function persistGroundingSourceHint(db, {
  campaignId, observationId, workspaceId, ownerId, originalCitationUrl,
  outcome, claimToken = null,
}, { now = () => new Date() } = {}) {
  if (![campaignId, observationId, workspaceId, ownerId].every(isWorkspaceId) ||
      !OBSERVATION_ID.test(observationId)) {
    throw new TypeError("Owner-scoped campaign observation required");
  }
  const fields = validateGroundingOutcome(originalCitationUrl, outcome);
  const clock = now();
  if (!(clock instanceof Date) || !Number.isFinite(clock.getTime())) {
    throw new TypeError("Valid resolution timestamp required");
  }
  return db.$transaction(async tx => {
    if (!await lockActiveWorkspaceMembership(tx, {
      workspaceId, userId: ownerId,
    })) return { status: 403, code: "WORKSPACE_ACCESS_REVOKED" };

    // Lock order: workspace membership -> campaign -> observation.
    const campaigns = await tx.$queryRaw`
      SELECT "id","groundingRunStatus" FROM "ResearchCampaign"
      WHERE "id" = ${campaignId} AND "workspaceId" = ${workspaceId}
        AND "ownerId" = ${ownerId} AND "status" != 'CANCELLED'
      FOR UPDATE`;
    if (campaigns.length !== 1) {
      return { status: 404, code: "CAMPAIGN_NOT_FOUND" };
    }
    const rows = await tx.$queryRaw`
      SELECT "id","citationUrl","groundingStatus",
        "groundingResolvedUrl","groundingProvenance","groundingCode",
        "groundingLeaseToken","groundingLeaseUntil"
      FROM "ResearchCampaignObservation"
      WHERE "id" = ${observationId} AND "campaignId" = ${campaignId}
      FOR UPDATE`;
    if (rows.length !== 1) {
      return { status: 404, code: "OBSERVATION_NOT_FOUND" };
    }
    const row = rows[0];
    // Do not let a historical citation be silently replaced after an external
    // HEAD request. No stale or cross-campaign source may be committed.
    if (row.citationUrl !== originalCitationUrl) {
      return { status: 409, code: "GROUNDING_CITATION_CHANGED" };
    }
    // A completed identical write is a read-only replay, not a new
    // dispatch. Handle it before checking the cleared claim token.
    if (row.groundingStatus !== "UNCHECKED") {
      const same = row.groundingStatus === fields.groundingStatus &&
        row.groundingResolvedUrl === fields.groundingResolvedUrl &&
        row.groundingProvenance === fields.groundingProvenance &&
        row.groundingCode === fields.groundingCode;
      return same
        ? { status: 200, code: "GROUNDING_EVIDENCE_ALREADY_SAVED" }
        : { status: 409, code: "GROUNDING_EVIDENCE_IMMUTABLE" };
    }
    // A first commit requires the active fencing token. Expired or stopped
    // claims cannot write results after an uncertain external request.
    const running = campaigns[0].groundingRunStatus === "RUNNING";
    if (row.groundingLeaseToken != null || running) {
      if (!running || typeof claimToken !== "string" ||
          claimToken !== row.groundingLeaseToken ||
          !(row.groundingLeaseUntil instanceof Date) ||
          row.groundingLeaseUntil <= clock) {
        return { status: 409, code: "GROUNDING_LEASE_UNCONFIRMED" };
      }
    } else if (claimToken !== null) {
      return { status: 409, code: "GROUNDING_LEASE_UNCONFIRMED" };
    }
    const changed = await tx.researchCampaignObservation.updateMany({
      where: { id: observationId, campaignId,
        citationUrl: originalCitationUrl, groundingStatus: "UNCHECKED",
        groundingLeaseToken: claimToken },
      data: { ...fields, groundingResolvedAt: clock,
        groundingLeaseToken: null, groundingLeaseUntil: null },
    });
    if (changed.count !== 1) {
      return { status: 409, code: "GROUNDING_EVIDENCE_CONFLICT" };
    }
    await tx.auditEvent.create({ data: {
      actorId: ownerId, entityId: observationId,
      action: "research.campaign.grounding-source.recorded",
      metadata: {
        campaignId, workspaceId, groundingStatus: fields.groundingStatus,
        code: fields.groundingCode, provenance: fields.groundingProvenance,
        // Do not duplicate personal/profile URL data into the audit log.
        identityVerified: false, emailVerified: false,
        contactCreated: false, providerCalls: 0, sendingEnabled: false,
      },
    } });
    return { status: 201, code: "GROUNDING_EVIDENCE_RECORDED",
      groundingStatus: fields.groundingStatus };
  });
}
