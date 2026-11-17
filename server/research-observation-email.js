// Explicit read-only inspection of already stored, owner-scoped campaign evidence.
// A public name/email match is review evidence, not an approved outreach contact.
import { retrieveCitedPublicPage } from "./research-public-pages.js";
import { classifyExplicitPersonEmailPage } from "./candidate-direct-email-evidence.js";
import { publicCitationUrl } from "./research-evidence.js";

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
    select: { id: true, name: true, category: true, citationUrl: true },
  });
  if (!observation) return { status: 404, code: "OBSERVATION_NOT_FOUND" };
  const url = isDirectPublicProfileUrl(observation.citationUrl);
  if (!url) {
    return { status: 200, code: "DIRECT_PROFILE_SOURCE_REQUIRED",
      contactCreated: false, emailChecked: false, sendingEnabled: false };
  }
  // A shared page may be an index or directory, not this person's profile.
  // Refuse ambiguous attribution without inventing a contact or email.
  const others = await db.researchCampaignObservation.count({
    where: { campaignId, citationUrl: observation.citationUrl,
      id: { not: observationId } },
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
  // Revalidate ownership after the external read to avoid revealing public
  // evidence to a user whose membership was revoked while the fetch ran.
  const stillOwned = await db.researchCampaign.findFirst({
    where: { id: campaignId, workspaceId, ownerId },
    select: { id: true },
  });
  if (!stillOwned) return { status: 404, code: "CAMPAIGN_NOT_FOUND" };
  return { status: 200, code: "NAMED_EMAIL_EVIDENCE_REVIEW_REQUIRED",
    name: observation.name, category: observation.category,
    observedEmail: evidence.emailNormalized, sourceUrl: evidence.profileUrl,
    evidenceDigest: evidence.evidenceDigest,
    contactCreated: false, emailChecked: true, reviewRequired: true,
    onboardingEligible: false, sendingEnabled: false };
}
