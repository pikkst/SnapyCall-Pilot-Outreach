import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { loadResearchFunnelSnapshot } from "../server/research-funnel-snapshot-loader.js";

const integration = process.env.AI98_TEST_POSTGRES === "isolated-ci";

test("PostgreSQL read-only snapshot accepts active membership and rejects revoked membership", { skip: !integration }, async () => {
  const db = new PrismaClient();
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
    const loaded = await loadResearchFunnelSnapshot(db, scope);
    assert.equal(loaded.readOnly, true);
    assert.equal(loaded.completeness.complete, true);
    await db.partnerMembership.update({
      where: { partnerId_userId: { partnerId: workspace.id, userId: user.id } },
      data: { revokedAt: new Date() },
    });
    const revoked = await loadResearchFunnelSnapshot(db, scope);
    assert.equal(revoked.code, "WORKSPACE_ACCESS_REVOKED");
  } finally {
    await db.$disconnect();
  }
});
