// Conservative source-content corroboration: seeing a full expert name
// on the independently inspected cited page is review evidence, never proof
// of employment, contact ownership or even unique personal identity.
import { publicCitationUrl } from "./research-evidence.js";

function nameParts(value) {
  if (typeof value !== "string" || value.length < 5 || value.length > 160) return null;
  const words = value.normalize("NFKC").trim().split(/\s+/u);
  if (words.length < 2 || words.length > 8 ||
      words.some(word => word.length < 2 || !/^[\p{L}\p{M}'’.-]+$/u.test(word))) return null;
  return words;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function corroborateCandidateNames(candidates, inspectedPages) {
  if (!Array.isArray(candidates) || candidates.length > 20 ||
      !Array.isArray(inspectedPages) || inspectedPages.length > 3) {
    throw new TypeError("Invalid source corroboration envelope");
  }
  const inspected = new Map();
  for (const page of inspectedPages) {
    const url = publicCitationUrl(page?.url);
    if (!url || typeof page?.text !== "string" || page.text.length > 65_536) continue;
    inspected.set(url, page.text.normalize("NFKC"));
  }
  const result = [];
  for (const candidate of candidates) {
    const url = publicCitationUrl(candidate?.sourceUrl);
    if (!url || !inspected.has(url)) continue;
    const parts = nameParts(candidate?.name);
    const pattern = parts
      ? new RegExp("(^|[^\\p{L}\\p{N}])" +
          parts.map(escapeRegExp).join("\\s+") +
          "(?=$|[^\\p{L}\\p{N}])", "iu")
      : null;
    const mentioned = Boolean(pattern?.test(inspected.get(url)));
    result.push({
      name: candidate.name,
      sourceUrl: url,
      observation: mentioned ? "EXACT_NAME_ON_INSPECTED_SOURCE" : "NAME_NOT_OBSERVED",
      profileIdentityVerified: false,
      organizationAffiliationVerified: false,
      contactOwnershipVerified: false,
      reviewRequired: true,
    });
  }
  return result;
}
