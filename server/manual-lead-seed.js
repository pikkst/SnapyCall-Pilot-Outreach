// A human-supplied name and reference URL, not an automated extraction.
// This is deliberately narrower than the existing manual candidate contract.
import { z } from "zod";
import { normalizeCandidate, EXPERT_CATEGORIES } from "../src/domain.js";

export const manualLeadSeedInput = z.object({
  manualSeed: z.literal(true),
  name: z.string().trim().min(2).max(160),
  category: z.enum(Object.keys(EXPERT_CATEGORIES)),
  sourceUrl: z.string().trim().url().max(2048),
}).strict();

export function normalizeManualLeadSeed(value) {
  const input = manualLeadSeedInput.parse(value);
  const url = new URL(input.sourceUrl);
  // Only preserve a URL as user-entered provenance. Never fetch this URL,
  // bypass publisher terms, discover contact info or infer permission.
  if (url.protocol !== "https:" || url.port || url.username || url.password ||
      !url.hostname.includes(".") || url.hostname === "localhost" ||
      url.hostname.endsWith(".localhost") || url.hostname.endsWith(".local") ||
      url.hostname.endsWith(".internal") || url.hostname.endsWith(".invalid") ||
      /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) ||
      url.hostname.includes(":")) {
    throw new TypeError("An ordinary public HTTPS reference URL is required");
  }
  url.hash = "";
  const candidate = normalizeCandidate({
    name: input.name, category: input.category, sourceUrl: url.href,
    onlineEnglish: false, contactReviewed: false,
  });
  return Object.freeze({
    name: candidate.name, category: candidate.category,
    sourceUrl: candidate.sourceUrl,
  });
}
