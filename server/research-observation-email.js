// Explicit read-only inspection of already stored, owner-scoped campaign evidence.
// A public name/email match is review evidence, not an approved outreach contact.
import { retrieveCitedPublicPage } from "./research-public-pages.js";
import { classifyExplicitPersonEmailPage } from "./candidate-direct-email-evidence.js";
import { publicCitationUrl } from "./research-evidence.js";
import { requireWorkspaceMembership } from "./workspace-access.js";
import { isGoogleGroundingCitation } from "./research-grounding-location.js";

const ID = /^c[a-z0-9]{10,40}$/;
const redirectHost = "vertexaisearch.cloud.google.com";
export function isDirectPublicProfileUrl(value) {
  const canonical = publicCitationUrl(value);
  if (!canonical) return null;
  const url = new URL(canonical);
  if (url.hostname === redirectHost &&
      url.pathname.startsWith("/grounding-api-redirect/")) return null;
  return canonical;
}

// A redirect Location is an unverified hint, never proof of a named person.
// The existing bounded page reader + strict person/email classifier remains
// the only way to produce reviewable evidence from this source.
export function observationInspectionSource(observation) {
  if (!observation || typeof observation !== "object") return null;
  // Only an independently retrieved page with a deterministic exact-name
  // email label may override the original (possibly shared/opaque) citation.
  // An unverified AI URL proposal cannot satisfy this condition.
  if (observation.personSourceProvenance ===
        "AI98_EXPLICIT_NAMED_EMAIL_ON_PUBLIC_PROFILE" &&
      observation.emailTriageStatus === "REVIEW_REQUIRED" &&
      typeof observation.emailTriageDigest === "string" &&
      /^[a-f0-9]{64}$/.test(observation.emailTriageDigest) &&
      observation.personSourceVerifiedAt instanceof Date &&
      Number.isFinite(observation.personSourceVerifiedAt.getTime())) {
    const verified = isDirectPublicProfileUrl(observation.personSourceUrl);
    if (verified) return verified;
  }
  const direct = isDirectPublicProfileUrl(observation.citationUrl);
  if (direct) return observation.groundingStatus === "UNCHECKED" ||
      observation.groundingStatus == null ? direct : null;
  if (!isGoogleGroundingCitation(observation.citationUrl) ||
      observation.groundingStatus !== "SOURCE_HINT" ||
      observation.groundingProvenance !== "GOOGLE_GROUNDING_LOCATION_HEADER") return null;
  const resolved = isDirectPublicProfileUrl(observation.groundingResolvedUrl);
  // A second Google link is not an independently inspectable source.
  return resolved && !isGoogleGroundingCitation(resolved) ? resolved : null;
}

export async function inspectCampaignObservationEmail(db, {
  campaignId, observationId, workspaceId, ownerId,
}, { retrieve = retrieveCitedPublicPage } = {}) {
  if (![campaignId, observationId, workspaceId, ownerId].every(x =>
    typeof x === "string" && ID.test(x)) || typeof retrieve !== "function") {
    throw new TypeError("A valid scoped campaign observation is required");
  }
  // Never select observations by id alone; authorize the campaign owner first.
  const campaign = await db.researchCampaign.findFirst({
    where: { id: campaignId, workspaceId, ownerId },
    select: { id: true },
  });
  if (!campaign) return { status: 404, code: "CAMPAIGN_NOT_FOUND" };
  const observation = await db.researchCampaignObservation.findFirst({
    where: { id: observationId, campaignId },
    select: { id: true, name: true, category: true, citationUrl: true,
      groundingStatus: true, groundingResolvedUrl: true, groundingProvenance: true },
  });
  if (!observation) return { status: 404, code: "OBSERVATION_NOT_FOUND" };
  const url = observationInspectionSource(observation);
  if (!url) {
    return { status: 200, code: "DIRECT_PROFILE_SOURCE_REQUIRED",
      contactCreated: false, emailChecked: false, sendingEnabled: false };
  }
  // A shared page may be an index or directory, not this person's profile.
  // Refuse ambiguous attribution without inventing a contact or email.
  // A resolved destination can be shared by several distinct Gemini
  // citations (e.g. a directory). Reject both direct and resolved collisions.
  const others = await db.researchCampaignObservation.count({
    where: { campaignId, id: { not: observationId },
      OR: [{ citationUrl: url }, { groundingResolvedUrl: url }] },
  });
  if (others) {
    return { status: 200, code: "SHARED_SOURCE_REQUIRES_REVIEW",
      contactCreated: false, emailChecked: false, sendingEnabled: false };
  }
  let page;
  try { page = await retrieve(url); }
  catch {
    return { status: 200, code: "PROFILE_INSPECTION_UNAVAILABLE",
      contactCreated: false, emailChecked: false, sendingEnabled: false };
  }
  if (!page || publicCitationUrl(page.url) !== url || typeof page.text !== "string") {
    return { status: 200, code: "PROFILE_PROVENANCE_MISMATCH",
      contactCreated: false, emailChecked: false, sendingEnabled: false };
  }
  const evidence = classifyExplicitPersonEmailPage({
    name: observation.name, expertProfileUrl: url, email: null,
  }, page);
  if (evidence.status !== "REVIEW_REQUIRED") {
    return { status: 200, code: evidence.reason,
      contactCreated: false, emailChecked: true, sendingEnabled: false };
  }
  // External fetch can outlast a membership revocation. Check active auth
  // again before returning any person-associated address.
  const membership = await requireWorkspaceMembership(db, {
    workspaceId, userId: ownerId,
  });
  if (!membership) return { status: 403, code: "WORKSPACE_ACCESS_REVOKED" };
  const stillOwned = await db.researchCampaign.findFirst({
    where: { id: campaignId, workspaceId, ownerId },
    select: { id: true },
  });
  if (!stillOwned) return { status: 404, code: "CAMPAIGN_NOT_FOUND" };
  // The external fetch may outlive changes to the stored source binding.
  // Do not disclose a named email for a stale or reassigned hint.
  const current = await db.researchCampaignObservation.findFirst({
    where: { id: observationId, campaignId },
    select: { id: true, name: true, category: true, citationUrl: true,
      groundingStatus: true, groundingResolvedUrl: true, groundingProvenance: true },
  });
  if (!current || current.name !== observation.name ||
      current.category !== observation.category ||
      current.citationUrl !== observation.citationUrl ||
      observationInspectionSource(current) !== url) {
    return { status: 409, code: "PROFILE_SOURCE_CHANGED",
      contactCreated: false, emailChecked: false, sendingEnabled: false };
  }
  const conflicts = await db.researchCampaignObservation.count({
    where: { campaignId, id: { not: observationId },
      OR: [{ citationUrl: url }, { groundingResolvedUrl: url }] },
  });
  if (conflicts) return { status: 200, code: "SHARED_SOURCE_REQUIRES_REVIEW",
    contactCreated: false, emailChecked: false, sendingEnabled: false };
  return { status: 200, code: "NAMED_EMAIL_EVIDENCE_REVIEW_REQUIRED",
    name: observation.name, category: observation.category,
    observedEmail: evidence.emailNormalized, sourceUrl: evidence.profileUrl,
    evidenceDigest: evidence.evidenceDigest,
    contactCreated: false, emailChecked: true, reviewRequired: true,
    onboardingEligible: false, sendingEnabled: false };
}
