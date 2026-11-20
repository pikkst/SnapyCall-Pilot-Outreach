import test from "node:test";
import assert from "node:assert/strict";
import { summarizeResearchFunnel } from "../server/research-funnel-baseline.js";

const digest = "a".repeat(64);
const base = () => ({ scope: { workspaceId: "cmabcdefghijklmnopqrstu", ownerId: "cmabcdefghijklmnopqrstv" },
  completeness: { complete: true, totalObservations: 1, returnedObservations: 1 },
  discoveryRun: { startedTasks: 2 }, tasks: [{ status: "COMPLETED" }],
  observations: [{ name: "Ada Lovelace", category: "COACHING", emailTriageStatus: "REVIEW_REQUIRED", emailTriageCode: "NAMED_EMAIL_EVIDENCE_REVIEW_REQUIRED", emailTriageEmail: "ada@example.org", emailTriageDigest: digest, emailTriageAt: new Date(), citationUrl: "https://example.org/ada" }],
  sourceJobs: [{ status: "COMPLETED", attempts: 1, proposedSourceUrl: "https://example.org/ada", lastErrorCode: null }], audits: [], acceptedContacts: [], spendReservations: [] });

test("reports distinct units, provenance, and qualified evidence without accepting contacts", () => {
  const result = summarizeResearchFunnel(base());
  assert.equal(result.stages.discoveryCalls.value, 2);
  assert.equal(result.stages.observations.value, 1);
  assert.equal(result.stages.qualifiedEvidence.value, 1);
  assert.equal(result.stages.humanAcceptedContacts.value, null);
  assert.equal(result.stages.qualifiedEvidence.source.includes("persisted"), true);
  assert.equal(result.readOnly, true);
});

test("keeps legacy access metadata and unreconciled cost unknown", () => {
  const snapshot = base();
  snapshot.audits = [{ action: "legacy", metadata: {} }];
  snapshot.spendReservations = [{ chargedCents: null }];
  const result = summarizeResearchFunnel(snapshot);
  assert.equal(result.accessibility.reconstructable, false);
  assert.equal(result.accessibility.counts, null);
  assert.equal(result.cost.reconstructable, false);
  assert.equal(result.cost.totalChargedCents, null);
  assert.equal(result.cost.unknownReservationCount, 1);
});

test("counts historical and current reason codes separately and preserves scope", () => {
  const snapshot = base();
  snapshot.sourceJobs.push({ status: "COMPLETED", attempts: 1, lastErrorCode: "SOURCE_ALL_PAGES_UNAVAILABLE", proposedSourceUrl: null });
  snapshot.observations[0].emailTriageCode = "LEGACY_NO_EMAIL";
  const result = summarizeResearchFunnel(snapshot);
  assert.equal(result.reasonCodes.sourceJobs.SOURCE_ALL_PAGES_UNAVAILABLE, 1);
  assert.equal(result.reasonCodes.inspection.LEGACY_NO_EMAIL, 1);
  assert.deepEqual(result.workspaceScope, { workspaceId: "cmabcdefghijklmnopqrstu", ownerId: "cmabcdefghijklmnopqrstv" });
});

test("empty and incomplete snapshots never invent access or qualified counts", () => {
  const result = summarizeResearchFunnel({ scope: { workspaceId: "cmabcdefghijklmnopqrstu", ownerId: "cmabcdefghijklmnopqrstv" }, tasks: [], observations: [], sourceJobs: [], audits: [], acceptedContacts: [] });
  assert.equal(result.stages.qualifiedEvidence.value, null);
  assert.equal(result.accessibility.counts, null);
  assert.equal(result.cost.totalChargedCents, null);
});

test("unknown qualification, URL attempts, and review-pending batch items stay unknown", () => {
  const snapshot = base();
  snapshot.observations = Array.from({ length: 251 }, () => snapshot.observations[0]);
  snapshot.completeness = { complete: true, totalObservations: 251, returnedObservations: 251 };
  snapshot.audits = [{ metadata: { sourceInspection: { attempted: 3 } } }];
  snapshot.acceptedContacts = [{ status: "QUEUED" }, { status: "SAVED", resultCode: "CONTACT_SAVED_REVIEW_PENDING" }];
  const result = summarizeResearchFunnel(snapshot);
  assert.equal(result.stages.qualifiedEvidence.value, null);
  assert.equal(result.stages.qualifiedEvidence.reconstructable, false);
  assert.equal(result.stages.urlInspectionAttempts.value, 3);
  assert.equal(result.stages.humanAcceptedContacts.value, null);
});

test("a partial snapshot at or below 250 rows cannot report qualification", () => {
  const snapshot = base();
  snapshot.completeness = { complete: false, totalObservations: 400, returnedObservations: 1 };
  const result = summarizeResearchFunnel(snapshot);
  assert.equal(result.stages.qualifiedEvidence.value, null);
  assert.equal(result.stages.namedPersonEmailEvidence.value, null);
});

test("named-email evidence requires the exact persisted evidence code", () => {
  const snapshot = base();
  snapshot.observations.push({ ...snapshot.observations[0], emailTriageCode: "OTHER_REVIEW_REQUIRED" });
  snapshot.completeness = { complete: true, totalObservations: 2, returnedObservations: 2 };
  const result = summarizeResearchFunnel(snapshot);
  assert.equal(result.stages.reviewRequired.value, 2);
  assert.equal(result.stages.namedPersonEmailEvidence.value, 1);
});

test("invalid or missing owner/workspace scope fails closed", () => {
  assert.throws(() => summarizeResearchFunnel({ tasks: [], observations: [], sourceJobs: [], audits: [], acceptedContacts: [] }), TypeError);
  assert.throws(() => summarizeResearchFunnel({ scope: { workspaceId: "other", ownerId: "cmabcdefghijklmnopqrstv" }, tasks: [], observations: [], sourceJobs: [], audits: [], acceptedContacts: [] }), TypeError);
});
