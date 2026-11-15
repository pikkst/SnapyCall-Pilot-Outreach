// Bounded, optional enrichment stage for a provider-cited expert preview.
// Independent page inspection is never proof of an individual person's email.
import { retrieveCitedPublicPage } from "./research-public-pages.js";
import { observedPublicBusinessContacts } from "./research-contact-evidence.js";
import { publicCitationUrl } from "./research-evidence.js";
import { associateBusinessContactsWithCandidates, findCandidateIdentityCollisions } from "./research-contact-attribution.js";

export async function inspectResearchPreview(preview, {
  retrieve = retrieveCitedPublicPage, maxPages = 2,
} = {}) {
  if (!preview || !Array.isArray(preview.candidates) ||
      !Array.isArray(preview.sources) || preview.sources.length > 60 ||
      !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 3) {
    throw new TypeError("Invalid research inspection plan");
  }
  const cited = new Set(preview.sources.map(item => publicCitationUrl(item?.url)).filter(Boolean));
  const visited = new Set();
  const contacts = [];
  const warnings = [];
  let inspected = 0;
  for (const candidate of preview.candidates) {
    const url = publicCitationUrl(candidate?.sourceUrl);
    if (!url || !cited.has(url) || visited.has(url)) continue;
    visited.add(url);
    if (inspected >= maxPages) break;
    inspected++;
    try {
      const page = await retrieve(url);
      // A trusted fetch must return precisely the source it was asked to
      // inspect, with no client-controlled URL or unverified redirect.
      if (!page || publicCitationUrl(page.url) !== url ||
          typeof page.text !== "string") throw new Error("PAGE_PROVENANCE_MISMATCH");
      const observations = observedPublicBusinessContacts({
        trustedPages: [page], citationUrls: [url],
      });
      contacts.push(...observations);
    } catch {
      // Individual source failures cannot reveal internal DNS, keys or URLs
      // through error messages and must never cancel a charged AI request.
      warnings.push("One public source could not be independently inspected");
    }
  }
  return {
    publicBusinessContacts: contacts,
    contactAssociations: associateBusinessContactsWithCandidates(preview.candidates, contacts),
    identityCollisions: findCandidateIdentityCollisions(preview.candidates),
    pagesInspected: inspected,
    contactReviewRequired: true,
    warnings: [...new Set(warnings)],
  };
}
