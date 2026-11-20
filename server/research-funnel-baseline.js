// RD-01: deterministic, read-only evidence-funnel diagnostic.
// This module consumes an owner/workspace-scoped persisted snapshot supplied by
// the caller. It never fetches sources, writes audit events, or changes state.
import { summarizeQualifiedEmailEvidence } from "./research-qualified-evidence.js";

const TERMINAL_INSPECTION = new Set(["REVIEW_REQUIRED", "NO_EMAIL", "BLOCKED", "UNCERTAIN"]);
const ACCESS = new Set(["robots", "redirect", "dns", "http", "timeout", "content", "linked", "other"]);

function metric(value, unit, denominator, source, reconstructable = value !== null) {
  return Object.freeze({ value, unit, denominator, source, reconstructable });
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function countBy(rows, field, values = null) {
  const counts = {};
  for (const row of rows) {
    const value = row?.[field];
    if (values && !values.has(value)) continue;
    if (typeof value === "string") counts[value] = (counts[value] ?? 0) + 1;
  }
  return Object.freeze(counts);
}

function failureCounts(audits) {
  const result = Object.fromEntries([...ACCESS].map(key => [key, 0]));
  let available = false;
  for (const event of audits) {
    const failures = event?.metadata?.sourceInspection?.accessFailures;
    if (!failures || typeof failures !== "object") continue;
    available = true;
    for (const key of ACCESS) {
      const value = failures[key];
      if (Number.isSafeInteger(value) && value >= 0) result[key] += value;
    }
  }
  return { counts: Object.freeze(result), available };
}

function inspectionAttempts(audits) {
  const rows = audits.map(event => event?.metadata?.sourceInspection)
    .filter(value => value && typeof value === "object");
  if (!rows.length || rows.some(row => !Number.isSafeInteger(row.attempted) || row.attempted < 0)) {
    return null;
  }
  return rows.reduce((sum, row) => sum + row.attempted, 0);
}

function validScope(scope) {
  return scope && typeof scope === "object" &&
    /^c[a-z0-9]{10,40}$/.test(scope.workspaceId ?? "") &&
    /^c[a-z0-9]{10,40}$/.test(scope.ownerId ?? "");
}

export function summarizeResearchFunnel(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || !validScope(snapshot.scope) ||
      !Array.isArray(snapshot.tasks) ||
      !Array.isArray(snapshot.observations) || !Array.isArray(snapshot.sourceJobs) ||
      !Array.isArray(snapshot.audits) || !Array.isArray(snapshot.acceptedContacts)) {
    throw new TypeError("Persisted RD-01 funnel snapshot required");
  }
  const tasks = snapshot.tasks;
  const observations = snapshot.observations;
  const jobs = snapshot.sourceJobs;
  const audits = snapshot.audits;
  const accepted = snapshot.acceptedContacts;
  const discoveryCalls = safeCount(snapshot.discoveryRun?.startedTasks);
  const people = new Set(observations.map(row => `${row?.name ?? ""}\u0000${row?.category ?? ""}`)).size;
  const inspected = observations.filter(row => TERMINAL_INSPECTION.has(row?.emailTriageStatus)).length;
  const readable = observations.filter(row => row?.emailTriageStatus === "REVIEW_REQUIRED" || row?.emailTriageStatus === "NO_EMAIL").length;
  const qualified = observations.length <= 250
    ? summarizeQualifiedEmailEvidence(observations)
    : null;
  const attemptedUrls = inspectionAttempts(audits);
  const failures = failureCounts(audits);
  const sourceCompleted = jobs.filter(row => row?.status === "COMPLETED").length;
  const sourceAttempted = jobs.filter(row => Number.isSafeInteger(row?.attempts) && row.attempts > 0).length;
  const costs = Array.isArray(snapshot.spendReservations) ? snapshot.spendReservations : null;

  const stages = Object.freeze({
    discoveryCalls: metric(discoveryCalls, "provider calls started", discoveryCalls, "ResearchCampaignRun.startedTasks", discoveryCalls !== null),
    distinctProfessionals: metric(people, "distinct persisted observation name/category pairs", observations.length, "ResearchCampaignObservation.name + category", true),
    observations: metric(observations.length, "persisted observations", null, "ResearchCampaignObservation rows", true),
    sourceJobsPlanned: metric(jobs.length, "source jobs", observations.length, "ResearchPersonSourceJob rows", true),
    sourceJobsAttempted: metric(sourceAttempted, "source jobs with attempts > 0", jobs.length, "ResearchPersonSourceJob.attempts", sourceAttempted !== null),
    sourceJobsCompleted: metric(sourceCompleted, "source jobs status COMPLETED", jobs.length, "ResearchPersonSourceJob.status", true),
    providerCitedUrls: metric(new Set(jobs.map(row => row?.proposedSourceUrl).filter(url => typeof url === "string" && url.length > 0)).size, "distinct persisted proposed source URLs", sourceAttempted, "ResearchPersonSourceJob.proposedSourceUrl", true),
    urlInspectionAttempts: metric(attemptedUrls, "URL inspection attempts", null, "AuditEvent.metadata.sourceInspection.attempted", attemptedUrls !== null),
    readablePages: metric(readable, "readable inspection outcomes", inspected, "ResearchCampaignObservation.emailTriageStatus", true),
    namedPersonEmailEvidence: metric(qualified?.reviewRequired ?? null, "named-email evidence rows requiring review", inspected, "ResearchCampaignObservation.emailTriageCode", qualified !== null),
    qualifiedEvidence: metric(qualified?.qualifiedEvidence ?? null, "independently qualified person-email evidence", qualified?.reviewRequired ?? null, "summarizeQualifiedEmailEvidence; persisted observation fields", qualified?.countReliable === true),
    humanAcceptedContacts: metric(null, "CONTACT_ACCEPTED records", null, "No persisted CONTACT_ACCEPTED state exists in ResearchContactBatchItem; supplied items are review-pending or unresolved", false),
  });

  const reasonCodes = Object.freeze({
    sourceJobs: countBy(jobs, "lastErrorCode"),
    inspection: countBy(observations, "emailTriageCode"),
    historicalAuditActions: countBy(audits, "action"),
  });
  const accessibility = Object.freeze({
    counts: failures.available ? failures.counts : null,
    source: "AuditEvent.metadata.sourceInspection.accessFailures",
    reconstructable: failures.available,
    note: failures.available ? "Current allowlisted access-failure counters only; legacy events are unknown." : "No access-failure metadata was persisted; do not infer zeros.",
  });
  const cost = costs === null ? Object.freeze({ totalChargedCents: null, knownChargedCents: 0, unknownReservationCount: null, source: "ResearchSpendReservation rows not supplied", reconstructable: false, note: "Unknown or unreconciled cost is not zero." }) : Object.freeze({
    totalChargedCents: costs.every(row => Number.isSafeInteger(row?.chargedCents)) ? costs.reduce((sum, row) => sum + row.chargedCents, 0) : null,
    knownChargedCents: costs.reduce((sum, row) => sum + (Number.isSafeInteger(row?.chargedCents) ? row.chargedCents : 0), 0),
    unknownReservationCount: costs.filter(row => !Number.isSafeInteger(row?.chargedCents)).length,
    source: "ResearchSpendReservation.chargedCents",
    reconstructable: costs.every(row => Number.isSafeInteger(row?.chargedCents)),
    note: costs.some(row => row?.chargedCents == null) ? "Some reservations are unreconciled; totalChargedCents is unknown." : "All supplied reservations have charged cents.",
  });
  return Object.freeze({ stages, reasonCodes, accessibility, cost,
    overlapWarning: "Stage counts intentionally use different persisted units and must not be added together.",
    workspaceScope: snapshot.scope ?? null,
    readOnly: true,
  });
}
