// An explicit, user-clicked browser search; never fetch the source directory.
const categoryLabels = Object.freeze({
  AI_AUTOMATION: "AI automation consultant",
  COACHING: "professional coach or tutor",
  MARKETING_GROWTH: "marketing expert",
  BUSINESS_STRATEGY: "business consultant",
});

export function manualIndependentResearch(name, category, sourceUrl) {
  if (typeof name !== "string" || name.trim().length < 2 ||
      name.trim().length > 160 || !Object.hasOwn(categoryLabels, category)) {
    throw new TypeError("A validated expert name and category are required");
  }
  const source = new URL(sourceUrl);
  if (source.protocol !== "https:" || !source.hostname.includes(".") ||
      source.username || source.password || source.port) {
    throw new TypeError("Public HTTPS provenance required");
  }
  const hostname = source.hostname.toLowerCase();
  const criteria = [
    '"' + name.trim().replaceAll('"', "") + '"',
    categoryLabels[category],
    '-site:' + hostname,
  ].join(" ");
  return Object.freeze({
    criteria,
    // Navigation initiated by a user click; no server-side scraping or AI spend.
    searchUrl: "https://www.google.com/search?" + new URLSearchParams({ q: criteria }),
    excludedHostname: hostname,
  });
}
