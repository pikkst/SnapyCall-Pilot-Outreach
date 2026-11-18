// Deterministic, read-only research evidence qualification.
// This is NOT Candidate acceptance, consent, mailbox validation or send eligibility.
import { observationInspectionSource } from "./research-observation-email.js";

const EMAIL = /^[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9.-]+\.[a-z]{2,24}$/;
const GENERIC = /^(info|contact|hello|office|team|support|business|booking|bookings|partners|partnerships)$/;
const DIGEST = /^[a-f0-9]{64}$/;

function validNamedEmail(row) {
  const email = row?.emailTriageEmail;
  const name = row?.name;
  const category = row?.category;
  return row?.emailTriageStatus === "REVIEW_REQUIRED" &&
    row?.emailTriageCode === "NAMED_EMAIL_EVIDENCE_REVIEW_REQUIRED" &&
    typeof name === "string" && name.trim().length >= 5 &&
    typeof category === "string" && category.trim().length > 0 &&
    typeof email === "string" && email === email.toLowerCase() &&
    email.length <= 254 && EMAIL.test(email) && !email.includes("..") &&
    !GENERIC.test(email.split("@")[0]) &&
    typeof row?.emailTriageDigest === "string" &&
    DIGEST.test(row.emailTriageDigest) &&
    row?.emailTriageAt instanceof Date &&
    Number.isFinite(row.emailTriageAt.getTime());
}

// Counts only independently sourced, non-colliding, already-inspected named
// email evidence. Never return contact addresses or source URLs in this summary.
// Do not deduplicate conflicting identities by name alone.
export function summarizeQualifiedEmailEvidence(rows, { complete = true } = {}) {
  if (!Array.isArray(rows) || rows.length > 251 || typeof complete !== "boolean") {
    throw new TypeError("Bounded saved evidence snapshot required");
  }
  if (!complete || rows.length > 250) {
    return Object.freeze({ qualifiedEvidence: 0, reviewRequired: 0,
      ambiguous: 0, countReliable: false, contactsAccepted: 0,
      sendEligible: 0, sendingEnabled: false });
  }
  const sourceCounts = new Map();
  const emailCounts = new Map();
  for (const row of rows) {
    const source = observationInspectionSource(row);
    if (source) sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
    if (typeof row?.emailTriageEmail === "string") {
      const email = row.emailTriageEmail.toLowerCase();
      emailCounts.set(email, (emailCounts.get(email) ?? 0) + 1);
    }
  }
  let qualifiedEvidence = 0;
  let reviewRequired = 0;
  let ambiguous = 0;
  for (const row of rows) {
    if (row?.emailTriageStatus !== "REVIEW_REQUIRED") continue;
    reviewRequired++;
    const source = observationInspectionSource(row);
    if (!validNamedEmail(row) || !source ||
        sourceCounts.get(source) !== 1 ||
        emailCounts.get(row.emailTriageEmail) !== 1) {
      ambiguous++;
      continue;
    }
    qualifiedEvidence++;
  }
  return Object.freeze({ qualifiedEvidence, reviewRequired, ambiguous,
    countReliable: true, contactsAccepted: 0, sendEligible: 0,
    sendingEnabled: false });
}
