// Deterministic work planning for independently attributable person sources.
// No network access, AI calls, contact insertion or new authorization.
// One plan item refers to one immutable research observation, never a name match.
import { observationInspectionSource } from "./research-observation-email.js";

const MAX_ROWS = 250;
const FINISHED_EMAIL = new Set(["REVIEW_REQUIRED", "CHECKING"]);
const NEEDS_RESOLUTION = new Set([
  "UNCHECKED", "BLOCKED", "NO_EMAIL",
]);

function normalizeIdentity(row) {
  if (typeof row?.name !== "string" || typeof row?.category !== "string") {
    return null;
  }
  const name = row.name.normalize("NFKC").replace(/\s+/g, " ").trim();
  const category = row.category.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (name.length < 5 || name.length > 160 || category.length < 1 ||
      category.length > 120 || /[\r\n\t]/.test(name + category)) return null;
  return { name, category };
}

// Existing person profile is an inspectable URL, NOT identity verification.
// A shared URL never qualifies as an independent person-specific source.
export function planPersonSourceResolution(observations, {
  complete = true, maxJobs = MAX_ROWS,
} = {}) {
  if (!Array.isArray(observations) || observations.length > MAX_ROWS + 1 ||
      typeof complete !== "boolean" || !Number.isInteger(maxJobs) ||
      maxJobs < 0 || maxJobs > MAX_ROWS) {
    throw new TypeError("Bounded saved observation snapshot required");
  }
  if (!complete || observations.length > MAX_ROWS) {
    return Object.freeze({ reliable: false, total: observations.length,
      needsResolution: 0, alreadyInspectable: 0, alreadyInspected: 0,
      invalidIdentity: 0, inFlight: 0, jobs: Object.freeze([]) });
  }
  const frequencies = new Map();
  for (const row of observations) {
    const source = observationInspectionSource(row);
    if (source) frequencies.set(source, (frequencies.get(source) ?? 0) + 1);
  }
  const jobs = [];
  let needsResolution = 0;
  let alreadyInspectable = 0;
  let alreadyInspected = 0;
  let invalidIdentity = 0;
  let inFlight = 0;
  for (const row of observations) {
    if (FINISHED_EMAIL.has(row?.emailTriageStatus)) {
      if (row.emailTriageStatus === "CHECKING") inFlight++;
      else alreadyInspected++;
      continue;
    }
    if (!NEEDS_RESOLUTION.has(row?.emailTriageStatus)) {
      invalidIdentity++;
      continue;
    }
    const identity = normalizeIdentity(row);
    if (!identity || typeof row?.id !== "string" ||
        !/^c[a-z0-9]{10,40}$/.test(row.id)) {
      invalidIdentity++;
      continue;
    }
    const source = observationInspectionSource(row);
    if (source && frequencies.get(source) === 1 &&
        row.emailTriageStatus === "UNCHECKED") {
      alreadyInspectable++;
      continue;
    }
    needsResolution++;
    // The plan is research-only. The paid executor MUST recheck current row,
    // owner scope, entitlement, source provenance and budget before dispatch.
    if (jobs.length < maxJobs) jobs.push(Object.freeze({
      observationId: row.id, name: identity.name, category: identity.category,
      reason: source && frequencies.get(source) > 1 ? "SHARED_SOURCE" :
        row.emailTriageStatus === "NO_EMAIL" ? "ALTERNATE_EMAIL_SOURCE" :
        "PERSON_SOURCE_REQUIRED",
      // Query text is an instruction to an approved search adapter, not an URL.
      query: '"' + identity.name + '" ' + identity.category +
        " professional profile contact email",
    }));
  }
  return Object.freeze({ reliable: true, total: observations.length,
    needsResolution, alreadyInspectable, alreadyInspected, invalidIdentity,
    inFlight, jobs: Object.freeze(jobs) });
}

// Safe projection for owner-scoped read-only endpoints. No names, addresses,
// queries, source URLs or personal data leave the internal planning boundary.
export function publicPersonSourcePlan(plan) {
  if (!plan || typeof plan.reliable !== "boolean") {
    throw new TypeError("Valid resolution plan required");
  }
  const { reliable, total, needsResolution, alreadyInspectable,
    alreadyInspected, invalidIdentity, inFlight } = plan;
  return Object.freeze({ reliable, total, needsResolution,
    alreadyInspectable, alreadyInspected, invalidIdentity, inFlight,
    paidCallsAuthorized: false, emailSendingEnabled: false });
}
