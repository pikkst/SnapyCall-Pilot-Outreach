// Review-only associations between provider-cited experts and observed
// organization inboxes. A citation shared by multiple candidates is
// ambiguous; even an exclusive page never proves inbox ownership or consent.
import { publicCitationUrl } from "./research-evidence.js";

export function associateBusinessContactsWithCandidates(candidates, contacts) {
  if (!Array.isArray(candidates) || candidates.length > 20 ||
      !Array.isArray(contacts) || contacts.length > 20) {
    throw new TypeError("Invalid review association input");
  }
  const byUrl = new Map();
  for (const candidate of candidates) {
    const url = publicCitationUrl(candidate?.sourceUrl);
    if (!url || typeof candidate?.name !== "string" ||
        !candidate.name.trim() || candidate.name.length > 160) continue;
    const names = byUrl.get(url) ?? new Set();
    names.add(candidate.name.trim());
    byUrl.set(url, names);
  }
  const associations = [];
  const seen = new Set();
  for (const contact of contacts) {
    const url = publicCitationUrl(contact?.sourceUrl);
    if (!url || !byUrl.has(url) ||
        contact?.type !== "PUBLIC_BUSINESS_INBOX" ||
        contact?.provenance !== "SERVER_INSPECTED_PAGE" ||
        contact?.status !== "REVIEW_REQUIRED" ||
        contact?.identityVerified !== false ||
        contact?.contactPermission !== false ||
        typeof contact.observedEmail !== "string") continue;
    const key = url + "|" + contact.observedEmail.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const names = [...byUrl.get(url)];
    associations.push({
      sourceUrl: url,
      observedEmail: contact.observedEmail,
      candidateNames: names,
      relationship: names.length === 1
        ? "SAME_CITED_PAGE_UNVERIFIED"
        : "SHARED_SOURCE_AMBIGUOUS",
      organizationVerified: false,
      identityVerified: false,
      contactPermission: false,
      reviewRequired: true,
    });
  }
  return associations;
}

// Same spelling on different cited profiles can represent namesakes.
// Flag for human comparison rather than automatically merging identities.
export function findCandidateIdentityCollisions(candidates) {
  if (!Array.isArray(candidates) || candidates.length > 20) {
    throw new TypeError("Invalid candidate collection");
  }
  const groups = new Map();
  for (const candidate of candidates) {
    if (typeof candidate?.name !== "string") continue;
    const name = candidate.name.normalize("NFKC").trim().replace(/\s+/g, " ");
    const url = publicCitationUrl(candidate?.sourceUrl);
    if (!name || name.length > 160 || !url) continue;
    const key = name.toLocaleLowerCase("en");
    const entry = groups.get(key) ?? { name, sources: new Set() };
    entry.sources.add(url);
    groups.set(key, entry);
  }
  return [...groups.values()].filter(g => g.sources.size > 1)
    .map(g => ({
      name: g.name,
      sourceUrls: [...g.sources],
      status: "IDENTITY_REVIEW_REQUIRED",
      automaticMergeAllowed: false,
    }));
}


// Deterministic triage order based on observable evidence completeness, not
// guessed expertise, employability, identity or deliverability. The original
// candidate list is never modified. Unknown identities remain review-only.
export function orderCandidatesForEvidenceReview(candidates, inspectedUrls, contacts) {
  if (!Array.isArray(candidates) || candidates.length > 20 ||
      !Array.isArray(inspectedUrls) || inspectedUrls.length > 3 ||
      !Array.isArray(contacts) || contacts.length > 20) {
    throw new TypeError("Invalid candidate review evidence");
  }
  const inspected = new Set(inspectedUrls.map(publicCitationUrl).filter(Boolean));
  const contactUrls = new Set(contacts.filter(item =>
    item?.status === "REVIEW_REQUIRED" &&
    item?.type === "PUBLIC_BUSINESS_INBOX" &&
    item?.provenance === "SERVER_INSPECTED_PAGE" &&
    item?.identityVerified === false &&
    item?.contactPermission === false
  ).map(item => publicCitationUrl(item.sourceUrl)).filter(Boolean));
  return candidates.map((candidate, index) => {
    const url = publicCitationUrl(candidate?.sourceUrl);
    if (!url || typeof candidate?.name !== "string") return null;
    const sourceInspected = inspected.has(url);
    const hasBusinessInbox = sourceInspected && contactUrls.has(url);
    const evidenceLevel = hasBusinessInbox
      ? "PUBLIC_SOURCE_WITH_UNVERIFIED_BUSINESS_INBOX"
      : sourceInspected ? "PUBLIC_SOURCE_INSPECTED_NO_CONTACT"
      : "PROVIDER_CITATION_ONLY";
    return {
      name: candidate.name, sourceUrl: url, evidenceLevel,
      manualReviewRequired: true, individualEmailVerified: false,
      rank: hasBusinessInbox ? 0 : sourceInspected ? 1 : 2, originalIndex: index,
    };
  }).filter(Boolean).sort((a, b) =>
    a.rank - b.rank || a.originalIndex - b.originalIndex
  ).map(({ rank, originalIndex, ...item }) => item);
}
