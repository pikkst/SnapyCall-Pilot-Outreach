import test from "node:test";
import assert from "node:assert/strict";
import { preflightHistoricalFunnelAudit, validateAuditSelection } from "../server/research-funnel-audit-preflight.js";

const scope = { environment: "local-read-only", campaignId: "cmabcdefghijklmnopqrstu", workspaceId: "cmabcdefghijklmnopqrstv", ownerId: "cmabcdefghijklmnopqrstw" };
function db({ readOnly = "on", member = true, campaign = true } = {}) {
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async () => [{ database: "audit", role: "audit_reader", transaction_read_only: readOnly }],
    partnerMembership: { findUnique: async () => member ? { id: "m", revokedAt: null, role: "PARTNER", user: { id: scope.ownerId, googleSub: "synthetic" } } : null },
    researchCampaign: { findFirst: async () => campaign ? { id: scope.campaignId, status: "COMPLETED" } : null },
  };
  return { $transaction: async fn => fn(tx) };
}
test("requires explicit environment and complete scope", () => {
  assert.throws(() => validateAuditSelection({ ...scope, environment: "production" }));
  assert.throws(() => validateAuditSelection({ ...scope, ownerId: "bad" }));
});
test("fails closed for unsafe read-only, revoked membership, and wrong campaign", async () => {
  assert.equal((await preflightHistoricalFunnelAudit(db({ readOnly: "off" }), scope)).code, "READ_ONLY_NOT_ENFORCED");
  assert.equal((await preflightHistoricalFunnelAudit(db({ member: false }), scope)).code, "WORKSPACE_ACCESS_REVOKED");
  assert.equal((await preflightHistoricalFunnelAudit(db({ campaign: false }), scope)).code, "CAMPAIGN_NOT_FOUND");
});
test("returns sanitized database identity for an authorized audit", async () => {
  const result = await preflightHistoricalFunnelAudit(db(), scope);
  assert.deepEqual({ ok: result.ok, role: result.role, database: result.database, readOnly: result.readOnly }, { ok: true, role: "audit_reader", database: "audit", readOnly: true });
});
