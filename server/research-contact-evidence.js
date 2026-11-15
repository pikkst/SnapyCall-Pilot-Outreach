// Contact observations must originate from independently retrieved public
// page text. Provider/model JSON and citation URLs alone never prove an email.
// This module performs no network requests, scraping, or contact authorization.
import { publicCitationUrl } from "./research-evidence.js";

const GENERIC_MAILBOX = /^(?:info|contact|hello|office|team|business|enquiries|inquiries|support|partnerships|partners|booking|bookings)$/i;
const MAIL_PATTERN = /(?:^|[^\w.+-])([a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9.-]{1,190}\.[a-z]{2,24})(?![\w.-])/gi;

function normalizedEmail(raw) {
  if (typeof raw !== "string" || raw.length > 254 || /[\r\n<>\s]/.test(raw)) return null;
  const lower = raw.toLowerCase();
  const parts = lower.split("@");
  if (parts.length !== 2 || !GENERIC_MAILBOX.test(parts[0])) return null;
  const host = parts[1];
  if (!/^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?)+$/.test(host)) return null;
  return lower;
}

function compatibleMailDomain(email, pageUrl) {
  const domain = email.slice(email.indexOf("@") + 1);
  const host = new URL(pageUrl).hostname.toLowerCase();
  return domain === host || host.endsWith("." + domain) || domain.endsWith("." + host);
}

// trustedPages MUST be supplied by a future vetted server-side HTTP adapter,
// never from the browser, model output, or a user-controlled API property.
// Entries may represent documents the app actually inspected, not search snippets.
export function observedPublicBusinessContacts({ trustedPages, citationUrls }) {
  if (!Array.isArray(trustedPages) || trustedPages.length > 20 ||
      !Array.isArray(citationUrls) || citationUrls.length > 200) {
    throw new TypeError("Invalid inspected-page evidence");
  }
  const allowed = new Set(citationUrls.map(publicCitationUrl).filter(Boolean));
  const result = [];
  const seen = new Set();
  for (const page of trustedPages) {
    const url = publicCitationUrl(page?.url);
    if (!url || !allowed.has(url) ||
        typeof page?.text !== "string" || page.text.length > 200_000) continue;
    MAIL_PATTERN.lastIndex = 0;
    for (const match of page.text.matchAll(MAIL_PATTERN)) {
      const email = normalizedEmail(match[1]);
      if (!email || !compatibleMailDomain(email, url)) continue;
      const key = email + "|" + url;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        type: "PUBLIC_BUSINESS_INBOX",
        observedEmail: email,
        sourceUrl: url,
        provenance: "SERVER_INSPECTED_PAGE",
        status: "REVIEW_REQUIRED",
        // Presence on a public page does not establish person-level identity,
        // deliverability, lawful basis, or permission to send outreach.
        identityVerified: false, contactPermission: false,
      });
      if (result.length >= 20) return result;
    }
  }
  return result;
}
