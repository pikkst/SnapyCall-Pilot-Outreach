import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { loadResearchFunnelSnapshot } from "../server/research-funnel-snapshot-loader.js";
import { preflightHistoricalFunnelAudit } from "../server/research-funnel-audit-preflight.js";

const integration = process.env.AI98_TEST_POSTGRES === "isolated-ci";

test("PostgreSQL read-only snapshot accepts active membership and rejects revoked membership", { skip: !integration }, async () => {
  const db = new PrismaClient();
  const auditDb = new PrismaClient({ datasourceUrl: process.env.AUDIT_DATABASE_URL });
  const nonce = randomUUID().slice(0, 8);
  try {
    const user = await db.partnerUser.create({ data: {
      emailNormalized: `rd01b-${nonce}@example.org`, googleSub: `rd01b-${nonce}`,
    } });
    const workspace = await db.partner.create({ data: { name: `RD01B ${nonce}` } });
    await db.partnerMembership.create({ data: {
      partnerId: workspace.id, userId: user.id, inviteStatus: "ACCEPTED",
    } });
    const campaign = await db.researchCampaign.create({ data: {
      workspaceId: workspace.id, ownerId: user.id,
      idempotencyKey: `rd01b-${nonce}`, query: "synthetic", targetCount: 1,
      planVersion: "rd01b-test", status: "PARTIAL",
    } });
    const scope = { campaignId: campaign.id, workspaceId: workspace.id, ownerId: user.id };
    await db.$executeRawUnsafe('GRANT INSERT ON TABLE "ResearchPersonSourceJob" TO audit_reader');
    const unsafe = await preflightHistoricalFunnelAudit(auditDb, { ...scope, environment: "local-read-only", expectedDatabase: "snapycall_ci", expectedRole: "audit_reader" });
    assert.equal(unsafe.code, "AUDIT_ROLE_NOT_RESTRICTED");
    await db.$executeRawUnsafe('REVOKE INSERT ON TABLE "ResearchPersonSourceJob" FROM audit_reader');
    await db.$executeRawUnsafe('GRANT INSERT ON TABLE "ResearchCampaignTask" TO audit_reader');
    const unsafeTask = await preflightHistoricalFunnelAudit(auditDb, { ...scope, environment: "local-read-only", expectedDatabase: "snapycall_ci", expectedRole: "audit_reader" });
    assert.equal(unsafeTask.code, "AUDIT_ROLE_NOT_RESTRICTED");
    await db.$executeRawUnsafe('REVOKE INSERT ON TABLE "ResearchCampaignTask" FROM audit_reader');
    const preflight = await preflightHistoricalFunnelAudit(auditDb, { ...scope, environment: "local-read-only", expectedDatabase: "snapycall_ci", expectedRole: "audit_reader" });
    assert.equal(preflight.ok, true);
    assert.equal(preflight.readOnly, true);
    const loaded = await loadResearchFunnelSnapshot(auditDb, { ...scope, environment: "local-read-only", expectedDatabase: "snapycall_ci", expectedRole: "audit_reader" });
    assert.equal(loaded.readOnly, true);
    assert.equal(loaded.completeness.complete, true);
    await db.partnerMembership.update({
      where: { partnerId_userId: { partnerId: workspace.id, userId: user.id } },
      data: { revokedAt: new Date() },
    });
    const revoked = await loadResearchFunnelSnapshot(auditDb, { ...scope, environment: "local-read-only", expectedDatabase: "snapycall_ci", expectedRole: "audit_reader" });
    assert.equal(revoked.code, "WORKSPACE_ACCESS_REVOKED");
  } finally {
    await db.$disconnect();
    await auditDb.$disconnect();
  }
});
