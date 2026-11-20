import test from "node:test";
import assert from "node:assert/strict";
import { summarizeResearchFunnel } from "../server/research-funnel-baseline.js";

const digest = "a".repeat(64);
const base = () => ({ scope: { workspaceId: "ws-a", ownerId: "owner-a" },
  discoveryRun: { startedTasks: 2 }, tasks: [{ status: "COMPLETED" }],
  observations: [{ name: "Ada Lovelace", category: "COACHING", emailTriageStatus: "REVIEW_REQUIRED", emailTriageCode: "NAMED_EMAIL_EVIDENCE_REVIEW_REQUIRED", emailTriageEmail: "ada@example.org", emailTriageDigest: digest, emailTriageAt: new Date(), citationUrl: "https://example.org/ada" }],
  sourceJobs: [{ status: "COMPLETED", attempts: 1, proposedSourceUrl: "https://example.org/ada", lastErrorCode: null }], audits: [], acceptedContacts: [], spendReservations: [] });

test("reports distinct units, provenance, and qualified evidence without accepting contacts", () => {
  const result = summarizeResearchFunnel(base());
  assert.equal(result.stages.discoveryCalls.value, 2);
  assert.equal(result.stages.observations.value, 1);
  assert.equal(result.stages.qualifiedEvidence.value, 1);
  assert.equal(result.stages.humanAcceptedContacts.value, 0);
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
  assert.equal(result.cost.value, 0);
});

test("counts historical and current reason codes separately and preserves scope", () => {
  const snapshot = base();
  snapshot.sourceJobs.push({ status: "COMPLETED", attempts: 1, lastErrorCode: "SOURCE_ALL_PAGES_UNAVAILABLE", proposedSourceUrl: null });
  snapshot.observations[0].emailTriageCode = "LEGACY_NO_EMAIL";
  const result = summarizeResearchFunnel(snapshot);
  assert.equal(result.reasonCodes.sourceJobs.SOURCE_ALL_PAGES_UNAVAILABLE, 1);
  assert.equal(result.reasonCodes.inspection.LEGACY_NO_EMAIL, 1);
  assert.deepEqual(result.workspaceScope, { workspaceId: "ws-a", ownerId: "owner-a" });
});

test("empty and incomplete snapshots never invent access or qualified counts", () => {
  const result = summarizeResearchFunnel({ tasks: [], observations: [], sourceJobs: [], audits: [], acceptedContacts: [] });
  assert.equal(result.stages.qualifiedEvidence.value, 0);
  assert.equal(result.accessibility.counts, null);
  assert.equal(result.cost.value, null);
});
