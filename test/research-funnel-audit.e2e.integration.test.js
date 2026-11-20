import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { loadResearchFunnelSnapshot } from "../server/research-funnel-snapshot-loader.js";
import { summarizeResearchFunnel } from "../server/research-funnel-baseline.js";

const integration = process.env.AI98_TEST_POSTGRES === "isolated-ci";
const id = (suffix) => `cm${suffix.padEnd(20, "x")}`.slice(0, 24);
const digest = "a".repeat(64);
const base = (campaignId) => ({ scope: { campaignId, workspaceId: id("workspace"), ownerId: id("owner") }, completeness: { complete: true, totalObservations: 0, returnedObservations: 0 }, auditCompleteness: { complete: true, total: 0, returned: 0 }, reservationCompleteness: { complete: true, missing: 0 }, discoveryRun: { startedTasks: 1 }, tasks: [], observations: [], sourceJobs: [], audits: [], acceptedContacts: [], spendReservations: [] });
function evidenceSnapshot(kind) {
  const snapshot = base(id(kind));
  if (kind === "discovery-only") snapshot.discoveryRun.startedTasks = 2;
  if (kind === "source-failures") snapshot.sourceJobs = [{ status: "COMPLETED", attempts: 1, lastErrorCode: "SOURCE_ALL_PAGES_UNAVAILABLE" }];
  if (kind === "inaccessible") snapshot.audits = [{ metadata: { sourceInspection: { attempted: 1, accessFailures: { robots: 1, redirect: 0, dns: 0, http: 0, timeout: 0, content: 0, linked: 0, other: 0 } } } }];
  if (kind === "named-review" || kind === "qualified") snapshot.observations = [{ name: "Synthetic Person", category: "COACHING", emailTriageStatus: "REVIEW_REQUIRED", emailTriageCode: "NAMED_EMAIL_EVIDENCE_REVIEW_REQUIRED", emailTriageEmail: "synthetic@example.org", emailTriageDigest: digest, emailTriageAt: new Date(), citationUrl: "https://example.invalid/person" }];
  if (snapshot.observations.length) snapshot.completeness = { complete: true, totalObservations: snapshot.observations.length, returnedObservations: snapshot.observations.length };
  if (kind === "incomplete") { snapshot.observations = [{ name: "Synthetic Person", category: "COACHING" }]; snapshot.completeness = { complete: false, totalObservations: 2, returnedObservations: 1 }; }
  if (kind === "missing-audit") snapshot.auditCompleteness = { complete: false, total: 1, returned: 0 };
  if (kind === "missing-reservation") { snapshot.reservationCompleteness = { complete: false, missing: 1 }; snapshot.spendReservations = [{ chargedCents: 100 }]; }
  if (kind === "large") { snapshot.observations = Array.from({ length: 251 }, (_, i) => ({ name: `Synthetic ${i}`, category: "COACHING" })); snapshot.completeness = { complete: false, totalObservations: 251, returnedObservations: 251 }; }
  return snapshot;
}

test("synthetic audit cohort produces sanitized, denominator-aware loader/reducer evidence", { skip: !integration }, async () => {
  const writer = new PrismaClient();
  const db = new PrismaClient({ datasourceUrl: process.env.AUDIT_DATABASE_URL });
  try {
    const nonce = randomUUID().slice(0, 8);
    const user = await writer.partnerUser.create({ data: { emailNormalized: `rd01d-${nonce}@example.org`, googleSub: `rd01d-${nonce}` } });
    const workspace = await writer.partner.create({ data: { name: `RD01D ${nonce}` } });
    await writer.partnerMembership.create({ data: { partnerId: workspace.id, userId: user.id, inviteStatus: "ACCEPTED" } });
    const saved = await writer.researchCampaign.create({ data: { workspaceId: workspace.id, ownerId: user.id, idempotencyKey: `rd01d-${nonce}`, query: "synthetic", targetCount: 1, planVersion: "rd01d-test", status: "PARTIAL" } });
    const task = await writer.researchCampaignTask.create({ data: { campaignId: saved.id, taskIndex: 0, taskKey: `rd01d-${nonce}`, query: "synthetic", region: "global", facet: "synthetic", resultLimit: 1, status: "COMPLETED", attempts: 1, observedCount: 1 } });
    const observation = await writer.researchCampaignObservation.create({ data: { campaignId: saved.id, taskId: task.id, evidenceKey: `rd01d-${nonce}`, name: "Synthetic Person", category: "COACHING", citationUrl: "https://example.invalid/person", rationale: "synthetic fixture", emailTriageStatus: "REVIEW_REQUIRED", emailTriageCode: "NAMED_EMAIL_EVIDENCE_REVIEW_REQUIRED", emailTriageEmail: "synthetic@example.org", emailTriageDigest: digest, emailTriageAt: new Date() } });
    await writer.researchPersonSourceJob.create({ data: { campaignId: saved.id, observationId: observation.id, evidenceFingerprint: digest, reason: "PERSON_SOURCE", status: "COMPLETED", attempts: 1, proposedSourceUrl: "https://example.invalid/person", lastErrorCode: "SOURCE_ALL_PAGES_UNAVAILABLE" } });
    await writer.auditEvent.create({ data: { actorId: user.id, action: "research.person-source.attempt.settled", entityId: observation.id, metadata: { campaignId: saved.id, workspaceId: workspace.id, sourceInspection: { attempted: 1, accessFailures: { robots: 1, redirect: 0, dns: 0, http: 0, timeout: 0, content: 0, linked: 0, other: 0 } } } } });
    const campaign = { campaignId: saved.id, workspaceId: workspace.id, ownerId: user.id };
    const snapshot = await loadResearchFunnelSnapshot(db, { ...campaign, environment: "local-read-only", expectedDatabase: "snapycall_ci", expectedRole: "audit_reader" });
    assert.equal(snapshot.readOnly, true);
    const persistedReport = summarizeResearchFunnel(snapshot);
    assert.equal(persistedReport.stages.observations.value, 1);
    assert.equal(persistedReport.stages.sourceJobsCompleted.value, 1);
    assert.equal(persistedReport.accessibility.counts.robots, 1);
    assert.equal(persistedReport.stages.namedPersonEmailEvidence.value, 1);
    const cases = ["discovery-only", "source-failures", "inaccessible", "named-review", "qualified", "incomplete", "missing-audit", "missing-reservation", "large"].map(kind => [kind, summarizeResearchFunnel(evidenceSnapshot(kind))]);
    const report = Object.fromEntries(cases.map(([kind, result]) => [kind, { stages: result.stages, accessibility: result.accessibility, cost: result.cost }]));
    assert.equal(report["discovery-only"].stages.qualifiedEvidence.value, 0);
    assert.equal(report["source-failures"].stages.sourceJobsCompleted.value, 1);
    assert.equal(report.inaccessible.accessibility.counts.robots, 1);
    assert.equal(report["named-review"].stages.namedPersonEmailEvidence.value, 1);
    assert.equal(report.qualified.stages.qualifiedEvidence.value, 1);
    assert.equal(report.incomplete.stages.qualifiedEvidence.value, null);
    assert.equal(report["missing-audit"].accessibility.counts, null);
    assert.equal(report["missing-reservation"].cost.totalChargedCents, null);
    assert.equal(report.large.stages.qualifiedEvidence.value, null);
    assert.equal(JSON.stringify(report).includes("Synthetic Person"), false);
    assert.equal(JSON.stringify(report).includes("synthetic@example.org"), false);
  } finally { await db.$disconnect(); await writer.$disconnect(); }
});
