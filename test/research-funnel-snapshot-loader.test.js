import test from "node:test";
import assert from "node:assert/strict";
import { loadResearchFunnelSnapshot } from "../server/research-funnel-snapshot-loader.js";

const scope = { campaignId: "cmabcdefghijklmnopqrstu", workspaceId: "cmabcdefghijklmnopqrstv", ownerId: "cmabcdefghijklmnopqrstw", environment: "local-read-only", expectedDatabase: "audit", expectedRole: "audit_reader" };
const observation = { id: "cmabcdefghijklmnopqrs1", campaignId: scope.campaignId,
  taskId: "cmabcdefghijklmnopqrs2", name: "Synthetic Person", category: "COACHING",
  citationUrl: "https://example.invalid/person", status: "UNVERIFIED",
  emailTriageStatus: "UNCHECKED", emailTriageCode: null, emailTriageEmail: null,
  emailTriageDigest: null, emailTriageAt: null, groundingStatus: "UNCHECKED",
  groundingResolvedUrl: null, groundingProvenance: null, personSourceUrl: null,
  personSourceProvenance: null, personSourceVerifiedAt: null, candidateId: null };

function mockDb({ revoked = false, total = 1, rows = [observation], audits = [] } = {}) {
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async query => String(query).includes("information_schema") ? [
      ...[["PartnerMembership", ["partnerId", "userId", "revokedAt"]], ["ResearchCampaign", ["id", "workspaceId", "ownerId", "status"]], ["ResearchCampaignObservation", ["campaignId"]], ["ResearchPersonSourceJob", ["campaignId"]], ["ResearchSpendReservation", ["id", "workspaceId", "ownerId"]], ["AuditEvent", ["action", "metadata"]]].flatMap(([table, columns]) => columns.map(column_name => ({ table_name: table, column_name }))),
    ] : [{ database: "audit", role: "audit_reader", transaction_read_only: "on", rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false, campaign_write: false, audit_write: false }],
    partnerMembership: { findUnique: async ({ where }) => where.partnerId_userId.userId === scope.ownerId
      ? (revoked ? { revokedAt: new Date(), user: { id: scope.ownerId, googleSub: "synthetic" } } : { id: "membership", revokedAt: null, role: "PARTNER", user: { id: scope.ownerId, googleSub: "synthetic" } }) : null },
    researchCampaign: { findFirst: async ({ where }) => where.workspaceId === scope.workspaceId && where.ownerId === scope.ownerId ? {
      id: scope.campaignId, workspaceId: scope.workspaceId, ownerId: scope.ownerId,
      status: "PARTIAL", targetCount: 1, createdAt: new Date(), updatedAt: new Date(),
    } : null },
    researchCampaignObservation: {
      count: async () => total,
      findMany: async () => rows,
    },
    researchCampaignTask: { findMany: async () => [] },
    researchPersonSourceJob: { findMany: async () => [] },
    researchSpendReservation: { findMany: async () => [] },
    researchCampaignRun: { findUnique: async () => null },
    researchFullRun: { findUnique: async () => null },
    researchContactBatch: { findUnique: async () => null },
    auditEvent: { count: async () => audits.length, findMany: async () => audits },
  };
  return { $transaction: async callback => callback(tx) };
}

test("loads one authorized campaign with a real completeness proof", async () => {
  const snapshot = await loadResearchFunnelSnapshot(mockDb(), scope);
  assert.equal(snapshot.readOnly, true);
  assert.deepEqual(snapshot.completeness, { complete: true, totalObservations: 1, returnedObservations: 1 });
  assert.deepEqual(snapshot.scope, scope);
});

test("revoked membership and wrong owner/campaign fail closed", async () => {
  assert.equal((await loadResearchFunnelSnapshot(mockDb({ revoked: true }), scope)).code,
    "WORKSPACE_ACCESS_REVOKED");
  assert.equal((await loadResearchFunnelSnapshot(mockDb(), {
    ...scope, ownerId: "cmabcdefghijklmnopqrs99",
  })).code, "WORKSPACE_ACCESS_REVOKED");
  await assert.rejects(() => loadResearchFunnelSnapshot(mockDb(), {
    ...scope, campaignId: "invalid",
  }), TypeError);
});

test("does not claim completeness for truncated rows at the 250 boundary", async () => {
  const rows = Array.from({ length: 251 }, (_, index) => ({ ...observation, id: `cmabcdefghijklmnopq${String(index).padStart(3, "0")}` }));
  const snapshot = await loadResearchFunnelSnapshot(mockDb({ total: 251, rows }), scope);
  assert.deepEqual(snapshot.completeness, { complete: false, totalObservations: 251, returnedObservations: 251 });
});

test("keeps only matching campaign/workspace audit events and deduplicates references", async () => {
  const matching = { id: "audit-1", action: "research.person-source.attempt.settled",
    entityId: "job-1", metadata: { campaignId: scope.campaignId, workspaceId: scope.workspaceId,
      sourceInspection: { attempted: 1 } } };
  const unrelated = { id: "audit-2", action: matching.action, entityId: "job-2",
    metadata: { campaignId: "cmabcdefghijklmnopqrs99", workspaceId: scope.workspaceId } };
  const snapshot = await loadResearchFunnelSnapshot(mockDb({ audits: [matching, matching, unrelated] }), scope);
  assert.equal(snapshot.audits.length, 1);
  assert.equal(snapshot.audits[0].id, "audit-1");
});

test("empty campaign remains complete and read-only", async () => {
  const snapshot = await loadResearchFunnelSnapshot(mockDb({ total: 0, rows: [] }), scope);
  assert.deepEqual(snapshot.completeness, { complete: true, totalObservations: 0, returnedObservations: 0 });
  assert.equal(snapshot.observations.length, 0);
});

test("loader reports incomplete audit coverage instead of claiming full source metrics", async () => {
  const audits = Array.from({ length: 5001 }, (_, index) => ({
    id: `audit-${index}`, action: "research.person-source.attempt.settled",
    entityId: `job-${index}`, metadata: { campaignId: scope.campaignId,
      workspaceId: scope.workspaceId, sourceInspection: { attempted: 1 } },
  }));
  const snapshot = await loadResearchFunnelSnapshot(mockDb({ audits }), scope);
  assert.equal(snapshot.auditCompleteness.complete, false);
  assert.equal(snapshot.auditCompleteness.total, 5001);
});
