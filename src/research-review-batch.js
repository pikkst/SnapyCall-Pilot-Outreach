// Pure selection contract for an explicitly human-reviewed AI research batch.
// The server's existing manualSeed validator and workspace membership guards
// remain the authoritative authorization and source validation boundaries.
export function reviewedCandidateKey(candidate) {
  return candidate.name + "|" + candidate.sourceUrl;
}

export function resolvedReviewedSource(candidate, urls) {
  const key = reviewedCandidateKey(candidate);
  const url = (urls[key] ?? (candidate.sourceUrl.includes(
    "vertexaisearch.cloud.google.com/grounding-api-redirect/") ? "" :
    candidate.sourceUrl)).trim();
  if (!url || url.length > 2048) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
        parsed.port || !parsed.hostname.includes(".") ||
        parsed.hostname === "localhost" ||
        parsed.hostname.endsWith(".localhost") ||
        parsed.hostname.endsWith(".internal") ||
        parsed.hostname.endsWith(".local") ||
        parsed.hostname.endsWith(".invalid") ||
        parsed.hostname === "vertexaisearch.cloud.google.com" ||
        /^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname) ||
        parsed.hostname.includes(":")) return null;
    parsed.hash = "";
    return parsed.href;
  } catch { return null; }
}

export function reviewedSeedBatch(candidates, reviewedKeys, reviewedUrls, savedKeys) {
  if (!Array.isArray(candidates) || candidates.length > 20) return [];
  const reviewed = new Set(reviewedKeys);
  const saved = new Set(savedKeys);
  const seen = new Set();
  const results = [];
  for (const candidate of candidates) {
    const key = reviewedCandidateKey(candidate);
    if (!reviewed.has(key) || saved.has(key) || seen.has(key)) continue;
    const sourceUrl = resolvedReviewedSource(candidate, reviewedUrls);
    if (!sourceUrl) continue;
    seen.add(key);
    results.push({ key, manualSeed: true, name: candidate.name,
      category: candidate.category, sourceUrl });
  }
  return results;
}
