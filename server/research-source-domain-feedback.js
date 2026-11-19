// Pure, deterministic campaign-local feedback from previously inspected
// public sources. This does not fetch, crawl, retry, or authorize paid calls.
// Exclude a host only after repeated independently recorded unavailability.
// A single incident is insufficient evidence to suppress a useful source.
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export function isBoundedSourceDomain(host) {
  return typeof host === "string" && host.length <= 253 &&
    HOST.test(host);
}


export function repeatedUnavailableSourceDomains(rows, {
  minFailures = 2, maxDomains = 8,
} = {}) {
  if (!Array.isArray(rows) || rows.length > 250 ||
      !Number.isInteger(minFailures) || minFailures < 2 ||
      !Number.isInteger(maxDomains) || maxDomains < 1 || maxDomains > 20) {
    throw new TypeError("Bounded persisted source history required");
  }
  const failures = new Map();
  for (const row of rows) {
    if (row?.status !== "SOURCE_UNAVAILABLE" ||
        typeof row.proposedSourceUrl !== "string") continue;
    let url;
    try { url = new URL(row.proposedSourceUrl); }
    catch { continue; }
    if (url.protocol !== "https:" || url.username || url.password ||
        url.port || url.hostname.length > 253) continue;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (!isBoundedSourceDomain(host)) continue;
    failures.set(host, (failures.get(host) ?? 0) + 1);
  }
  return Object.freeze([...failures].filter(([, n]) => n >= minFailures)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxDomains).map(([host]) => host));
}
