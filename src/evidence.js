// Pure, server-side evidence and identity contracts. Evidence is recorded as
// untrusted observations and never grants qualification or contact permission.
export const EVIDENCE_KINDS = Object.freeze(["ARTICLE", "PROFILE", "SERVICE", "OTHER"]);

export function canonicalEvidenceUrl(value) {
  if (typeof value !== "string" || value.length > 2048) throw new TypeError("Invalid evidence URL");
  let url;
  try { url = new URL(value); } catch { throw new TypeError("Invalid evidence URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !url.hostname.includes(".") || !/^[a-z0-9.-]+$/i.test(url.hostname) ||
      url.hostname === "localhost" || url.hostname.endsWith(".localhost") ||
      url.hostname.endsWith(".local") || url.hostname.endsWith(".internal") ||
      url.hostname.includes("..") || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)) {
    throw new TypeError("Evidence must be an HTTPS public-domain URL");
  }
  url.hostname = url.hostname.toLowerCase();
  url.hash = "";
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_.*|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.toString();
}

export function sameIdentityHints(candidate, others) {
  const source = candidate.expertProfileUrl;
  const profile = source ? canonicalEvidenceUrl(source) : null;
  const email = typeof candidate.emailNormalized === "string" ? candidate.emailNormalized.toLowerCase() : null;
  return others.filter(other => other.id !== candidate.id).flatMap(other => {
    const reasons = [];
    if (email && other.emailNormalized?.toLowerCase() === email) reasons.push("same_email_address");
    if (profile && other.expertProfileUrl) {
      try { if (canonicalEvidenceUrl(other.expertProfileUrl) === profile) reasons.push("same_profile_url"); }
      catch { /* An invalid historical URL cannot establish identity. */ }
    }
    return reasons.length ? [{ id: other.id, reasons }] : [];
  });
}
