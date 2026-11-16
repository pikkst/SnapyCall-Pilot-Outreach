// Server-only deliverability signals. MX records establish routing for a
// domain, not the existence or activity of an individual mailbox.
// External verification is injectable and never runs without explicit config.
import { resolveMx as nodeResolveMx } from "node:dns/promises";

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const GENERIC_LOCAL = /^(?:info|contact|hello|office|team|business|enquiries|inquiries|support|partnerships|partners|booking|bookings)$/i;
const EMAIL_PATTERN = /^[a-z0-9][a-z0-9.!#$%&'*+/=?^_`{|}~-]*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export function normalizeVerificationAddress(value) {
  if (typeof value !== "string" || value.length > 254 ||
      value !== value.trim() || /[\r\n\s<>]/.test(value) ||
      !EMAIL_PATTERN.test(value)) return null;
  const [local, domain] = value.toLowerCase().split("@");
  if (local.length > 64 || domain.length > 253 || local.includes("..") ||
      domain.includes("..") || local.endsWith(".") || local.startsWith(".")) return null;
  return { email: local + "@" + domain, local, domain };
}

// Explicit fail-closed semantics: DNS outage is UNKNOWN, not INVALID.
export async function inspectEmailDomain(address, { resolveMx = nodeResolveMx,
  timeoutMs = 4000 } = {}) {
  const parsed = normalizeVerificationAddress(address);
  if (!parsed) return Object.freeze({ status: "INVALID", reason: "INVALID_SYNTAX",
    domainAcceptsMail: false });
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000 ||
      typeof resolveMx !== "function") throw new TypeError("Invalid DNS inspection configuration");
  let timer;
  try {
    const records = await Promise.race([
      resolveMx(parsed.domain),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("MX_TIMEOUT")), timeoutMs); }),
    ]);
    if (!Array.isArray(records) || records.length > 50 ||
        records.some(x => !x || !Number.isInteger(x.priority) ||
          x.priority < 0 || typeof x.exchange !== "string")) {
      return Object.freeze({ status: "UNKNOWN", reason: "INVALID_DNS_RESPONSE",
        domainAcceptsMail: null });
    }
    if (records.length === 1 && records[0].priority === 0 &&
        records[0].exchange.replace(/\.$/, "") === "") {
      return Object.freeze({ status: "INVALID", reason: "NULL_MX",
        domainAcceptsMail: false });
    }
    // A domain with no MX may legally accept mail via A/AAAA fallback.
    // Do not declare a specific address invalid from an empty MX answer.
    if (!records.length) return Object.freeze({ status: "UNKNOWN",
      reason: "NO_MX_FALLBACK_UNCHECKED", domainAcceptsMail: null });
    return Object.freeze({ status: "UNKNOWN", reason: "MX_PRESENT",
      domainAcceptsMail: true });
  } catch {
    return Object.freeze({ status: "UNKNOWN", reason: "DNS_UNAVAILABLE",
      domainAcceptsMail: null });
  } finally { clearTimeout(timer); }
}

export function normalizeVerificationProviderResult(raw) {
  // No raw provider payload is persisted or returned. Provider-specific
  // response parsing belongs to a reviewed adapter, not this trust boundary.
  const status = raw?.status;
  if (!["VALID", "INVALID", "RISKY", "UNKNOWN"].includes(status)) {
    return Object.freeze({ status: "UNKNOWN", reason: "PROVIDER_UNRECOGNIZED" });
  }
  const reason = typeof raw?.reason === "string" && /^[A-Z_]{2,48}$/.test(raw.reason)
    ? raw.reason : "PROVIDER_CLASSIFICATION";
  return Object.freeze({ status, reason });
}

export function onboardingEmailEligibility(candidate, verification, {
  now = new Date(), maxAgeMs = MAX_AGE_MS,
} = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      !Number.isInteger(maxAgeMs) || maxAgeMs < 1) throw new TypeError("Invalid eligibility clock");
  const blockers = [];
  const address = normalizeVerificationAddress(candidate?.email);
  const verifiedAddress = normalizeVerificationAddress(verification?.email);
  if (!address) blockers.push("EMAIL_MISSING_OR_INVALID");
  if (!address || !verifiedAddress || verifiedAddress.email !== address.email) {
    blockers.push("EMAIL_VERIFICATION_MISMATCH");
  }
  // A human name near an address, generic inbox, or model citation is NOT
  // enough. The explicit identity decision requires reviewed direct evidence.
  if (candidate?.personEmailLinked !== true ||
      candidate?.personEmailEvidenceReviewed !== true ||
      !candidate?.personEmailSourceUrl ||
      !/^https:\/\//i.test(candidate.personEmailSourceUrl)) {
    blockers.push("PERSON_EMAIL_LINK_NOT_VERIFIED");
  }
  if (address && GENERIC_LOCAL.test(address.local)) blockers.push("ORG_INBOX_NOT_PERSONAL");
  const checkedAt = verification?.checkedAt instanceof Date ?
    verification.checkedAt : typeof verification?.checkedAt === "string" ?
      new Date(verification.checkedAt) : null;
  if (!checkedAt || !Number.isFinite(checkedAt.getTime()) ||
      checkedAt > now || now.getTime() - checkedAt.getTime() > maxAgeMs) {
    blockers.push("DELIVERABILITY_CHECK_STALE");
  }
  if (verification?.status !== "VALID") blockers.push("DELIVERABILITY_NOT_CONFIRMED");
  if (candidate?.suppressed !== false) blockers.push("SUPPRESSION_NOT_CLEARED");
  if (candidate?.contactReviewed !== true || !candidate?.legalBasis) {
    blockers.push("CONTACT_LEGAL_REVIEW_REQUIRED");
  }
  return Object.freeze({ eligible: blockers.length === 0, blockers: Object.freeze(blockers),
    sendEnabled: false });
}
