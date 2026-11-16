import test from "node:test";
import assert from "node:assert/strict";
import { skipPausedResearchTask } from "../server/research-campaign-reconciliation.js";

const scope = {
  campaignId: "cmabcdefghijklmnopqrstu",
  workspaceId: "cmabcdefghijklmnopqrstv",
  ownerId: "cmabcdefghijklmnopqrstw",
  taskIndex: 2,
  confirmNoRetry: true,
  acceptConservativeCharge: true,
};
const taskId = "cmabcdefghijklmnopqrstx";
const reservationId = "7faca9cb-9333-4933-9b1a-4933e819aac0";

function fixture({ revoked = false, campaignMissing = false, running = 0,
  status = "PAUSED", lastErrorCode = "BILLING_UNCERTAIN",
  observations = 0, reservations = 1, settled = true, charged = 200,
  updated = 1, leaseUntil = null, attempts = 1 } = {}) {
  const events = [];
  const tx = {
    $queryRaw: async strings => {
      const sql = strings.join("?");
      if (sql.includes('FROM "PartnerMembership"')) {
        events.push("membership-lock");
        return [{ revokedAt: revoked ? new Date() : null }];
      }
      if (sql.includes('FROM "ResearchCampaign"')) {
        events.push("campaign-lock");
        return campaignMissing ? [] : [{ id: scope.campaignId }];
      }
      if (sql.includes('FROM "ResearchCampaignTask"')) {
        events.push("task-lock");
        return [{ id: taskId, status, lastErrorCode, leaseToken: null,
          leaseUntil, observedCount: 0, attempts }];
      }
      throw new Error("unexpected query");
    },
    researchCampaignTask: {
      count: async () => running,
      updateMany: async ({ where, data }) => {
        events.push("task-write");
        assert.equal(where.campaignId, scope.campaignId);
        assert.equal(where.status, "PAUSED");
        assert.equal(data.status, "CANCELLED");
        return { count: updated };
      },
    },
    researchCampaignObservation: {
      count: async () => observations,
    },
    auditEvent: {
      findMany: async ({ where }) => {
        assert.equal(where.action, "research.campaign.spend.reserved");
        return Array.from({ length: reservations }, () => ({
          entityId: reservationId, metadata: {
            campaignId: scope.campaignId, workspaceId: scope.workspaceId,
            taskId,
          },
        }));
      },
      create: async ({ data }) => {
        events.push("audit");
        assert.equal(data.action, "research.campaign.uncertain-task-skipped");
        assert.equal(data.metadata.acceptedConservativeCents, 200);
        assert.equal(data.metadata.externalProviderChargeVerified, false);
        assert.equal(data.metadata.replayPermitted, false);
      },
    },
    researchSpendReservation: {
      findUnique: async ({ where }) => {
        assert.equal(where.id, reservationId);
        return {
          id: reservationId, ownerId: scope.ownerId,
          workspaceId: scope.workspaceId,
          status: settled ? "SETTLED" : "RESERVED",
          settledAt: settled ? new Date() : null,
          reservedCents: 200, chargedCents: charged,
        };
      },
    },
  };
  return { events, db: { $transaction: fn => fn(tx) } };
}

test("explicit conservative skip of task three audits once; no provider or ledger writes", async () => {
  const { db, events } = fixture();
  const out = await skipPausedResearchTask(db, scope);
  assert.deepEqual(out, {
    status: 200, code: "UNCERTAIN_TASK_SKIPPED",
    changed: true, taskIndex: 2,
    conservativeChargeCents: 200,
    externalProviderChargeVerified: false,
    sendingEnabled: false,
  });
  assert.deepEqual(events, ["membership-lock", "campaign-lock",
    "task-lock", "task-write", "audit"]);
});

test("repeated skip is idempotent and does not create another audit", async () => {
  const f = fixture({ status: "CANCELLED" });
  const out = await skipPausedResearchTask(f.db, scope);
  assert.equal(out.code, "ALREADY_SKIPPED");
  assert.equal(out.changed, false);
  assert.ok(!f.events.includes("audit"));
});

test("no confirmation, wrong scope and malformed input cannot start", async () => {
  for (const change of [
    { confirmNoRetry: false }, { acceptConservativeCharge: false },
    { taskIndex: -1 }, { workspaceId: "attacker" },
  ]) {
    const f = fixture();
    await assert.rejects(() => skipPausedResearchTask(f.db,
      { ...scope, ...change }), TypeError);
    assert.deepEqual(f.events, []);
  }
});

test("revocation and missing campaign fail before mutation", async () => {
  for (const mode of [{ revoked: true }, { campaignMissing: true }]) {
    const f = fixture(mode);
    const out = await skipPausedResearchTask(f.db, scope);
    assert.notEqual(out.status, 200);
    assert.ok(!f.events.includes("task-write"));
  }
});

test("active task, committed evidence and stale lease are not skipped", async () => {
  for (const mode of [
    { running: 1 }, { observations: 1 },
    { leaseUntil: new Date() }, { status: "RUNNING" },
    { lastErrorCode: "PERMISSION_REVOKED" }, { attempts: 0 },
  ]) {
    const f = fixture(mode);
    const out = await skipPausedResearchTask(f.db, scope);
    assert.equal(out.status, 409);
    assert.ok(!f.events.includes("task-write"));
  }
});

test("ambiguous or still reserved spend prevents bypassing reconciliation", async () => {
  for (const mode of [
    { reservations: 0 }, { reservations: 2 },
    { settled: false }, { charged: 100 },
    { updated: 0 },
  ]) {
    const f = fixture(mode);
    const out = await skipPausedResearchTask(f.db, scope);
    assert.equal(out.status, 409);
    assert.ok(!f.events.includes("audit"));
  }
});
