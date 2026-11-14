// Provider-independent, review-only research evidence contract.
// A model-produced URL is never evidence unless found in trusted provider metadata.
import { z } from "zod";

const candidateSchema = z.object({
  name: z.string().trim().min(2).max(160),
  category: z.enum(["AI_AUTOMATION", "COACHING", "MARKETING_GROWTH", "BUSINESS_STRATEGY"]),
  sourceUrl: z.string().url().max(2048),
  rationale: z.string().trim().min(8).max(700),
}).strict();

export function publicCitationUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
        !host.includes(".") || host === "localhost" ||
        host.endsWith(".localhost") || host.endsWith(".local") ||
        host.endsWith(".internal") || host.endsWith(".test") ||
        host.endsWith(".invalid") ||
        /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
        host.includes(":") || host.startsWith("0x")) return null;
    url.hash = "";
    return url.href;
  } catch { return null; }
}

// Only call with source entries extracted from provider-supplied citation /
// grounding metadata, not with URLs the model wrote in its prose/JSON.
export function normalizeResearchEvidence({ text, citations, limit }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20 ||
      typeof text !== "string" || text.length > 50_000 ||
      !Array.isArray(citations) || citations.length > 200) {
    throw new TypeError("Invalid research evidence envelope");
  }
  const cited = new Map();
  for (const entry of citations) {
    const url = publicCitationUrl(entry?.url);
    if (url) cited.set(url, typeof entry.title === "string" ? entry.title.slice(0, 180) : "");
  }
  if (!cited.size) return {
    candidates: [], sources: [], warnings: ["No provider-cited sources returned"],
  };
  const jsonText = text.trim().replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  let parsed;
  try { parsed = JSON.parse(jsonText); }
  catch { throw new Error("AI research did not return structured results"); }
  if (!parsed || !Array.isArray(parsed.candidates) || parsed.candidates.length > 20) {
    throw new Error("AI research returned an invalid candidate list");
  }
  const candidates = [];
  const seen = new Set();
  for (const item of parsed.candidates) {
    const parsedItem = candidateSchema.safeParse(item);
    if (!parsedItem.success) continue;
    const sourceUrl = publicCitationUrl(parsedItem.data.sourceUrl);
    if (!sourceUrl || !cited.has(sourceUrl)) continue;
    const key = parsedItem.data.name.toLowerCase() + "|" + sourceUrl;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      ...parsedItem.data, sourceUrl,
      email: null, contactReviewed: false, profileReviewed: false,
      status: "REVIEW_PENDING",
    });
    if (candidates.length >= limit) break;
  }
  return {
    candidates,
    sources: [...cited].map(([url, title]) => ({ url, title })).slice(0, 60),
    warnings: candidates.length ? [] : ["No evidence-linked candidates matched the requested criteria"],
  };
}
