// AI Discovery intake is a review-queue operation, not contact verification.
import { createHash } from "node:crypto";
import { z } from "zod";
import { EXPERT_CATEGORIES } from "../src/domain.js";
import { publicCitationUrl } from "./research-evidence.js";

const input = z.object({
  discoverySeed: z.literal(true),
  name: z.string().trim().min(2).max(160),
  category: z.enum(Object.keys(EXPERT_CATEGORIES)),
  citationUrl: z.string().url().max(2048),
}).strict();

export function normalizeDiscoveryLeadSeed(value) {
  const parsed = input.parse(value);
  const citationUrl = publicCitationUrl(parsed.citationUrl);
  if (!citationUrl) throw new TypeError("A provider citation URL is required");
  const url = new URL(citationUrl);
  // A Google grounding transport URL is a pointer, not a reviewed source.
  const sourceUrl = url.hostname === "vertexaisearch.cloud.google.com" &&
    url.pathname.startsWith("/grounding-api-redirect/") ? null : citationUrl;
  const identity = [parsed.name.trim().toLowerCase(), parsed.category, citationUrl];
  const discoveryKey = createHash("sha256").update(JSON.stringify(identity))
    .digest("hex");
  return Object.freeze({
    name: parsed.name, category: parsed.category, sourceUrl,
    researchCitationUrl: citationUrl, discoveryKey,
  });
}
