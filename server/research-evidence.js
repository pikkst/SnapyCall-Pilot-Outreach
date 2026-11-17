// Provider-independent, review-only research evidence contract.
// A model-produced URL is never evidence unless found in trusted provider metadata.
import { z } from "zod";
import { createHash } from "node:crypto";

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
    warnings: [
      ...(candidates.length ? [] :
        ["No evidence-linked candidates matched the requested criteria"]),
      ...(parsed.candidates.length > candidates.length ?
        [String(parsed.candidates.length - candidates.length) +
          " AI suggestions were not accepted because their exact source URL was not provider-cited, their fields failed validation, or the result limit was reached."] : []),
    ],
  };
}


// Bound, canonicalize and digest retrieval records BEFORE passing excerpts to
// any model. A digest proves exact manifest bytes, not source truth or consent.
// Callers must supply records from an independently authorized provider
// adapter; this function NEVER performs HTTP or confers fetch permission.
export function buildBoundedRetrievalManifest({ provider, observedAt, records }) {
  if (typeof provider !== "string" || !/^[a-z][a-z0-9_-]{1,39}$/.test(provider) ||
      typeof observedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(observedAt) ||
      !Number.isFinite(Date.parse(observedAt)) ||
      new Date(observedAt).toISOString() !== observedAt ||
      !Array.isArray(records) || records.length < 1 || records.length > 20) {
    throw new TypeError("Invalid bounded retrieval manifest envelope");
  }
  const normalized = [];
  const seenIds = new Set();
  for (const record of records) {
    const id = record?.sourceId;
    const url = publicCitationUrl(record?.url);
    if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(id) ||
        !url || seenIds.has(id) || typeof record.title !== "string" ||
        !record.title.trim() || record.title.length > 180 ||
        typeof record.excerpt !== "string" || !record.excerpt.trim() ||
        record.excerpt.length > 1500) {
      throw new TypeError("Invalid or duplicate retrieval evidence record");
    }
    // A Google citation redirect is not an independently durable source.
    if (new URL(url).hostname === "vertexaisearch.cloud.google.com" &&
        new URL(url).pathname.startsWith("/grounding-api-redirect/")) {
      throw new TypeError("Opaque grounding redirect cannot be source evidence");
    }
    seenIds.add(id);
    normalized.push({
      sourceProvider: provider,
      sourceId: id,
      url,
      title: record.title.trim(),
      excerpt: record.excerpt.trim(),
      observedAt,
    });
  }
  normalized.sort((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);
  const canonicalBytes = JSON.stringify({ version: "bounded-retrieval-v1", records: normalized });
  const digest = createHash("sha256").update(canonicalBytes, "utf8").digest("hex");
  return Object.freeze({
    version: "bounded-retrieval-v1",
    records: Object.freeze(normalized.map(item => Object.freeze(item))),
    digest,
  });
}
