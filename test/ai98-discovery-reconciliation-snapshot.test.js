import test from "node:test";
import assert from "node:assert/strict";
import { inspectDiscoveryLeaseReconciliation }
  from "../server/research-campaign-reconciliation.js";

const ids = { campaignId: "cmabcdefghijklmnopqrstu",
  workspaceId: "cmabcdefghijklmnopqrstv",
  ownerId: "cmabcdefghijklmnopqrstw" };
const taskId = "cmabcdefghijklmnopqrtask";
const reservationId = "reservation-1";
const clock = new Date("2026-11-19T17:00:00.000Z");

function fixture({ authorized = true, receipt = false, intent = true,
  reservation = "RESERVED", wrongOwner = false, duplicate = false,
  leaseUntil = new Date("2026-11-19T16:54:00.000Z") } = {}) {
  const calls = [];
  const database = {
    researchFullRun: { findUnique: async () => {
      calls.push("full");
      return { workspaceId: ids.workspaceId,
        ownerId: wrongOwner ? "cmwrongowner123456789" : ids.ownerId,
        status: "NEEDS_REVIEW",
        lastCode: "DISCOVERY_APPROVAL_RECONCILIATION_REQUIRED" };
    } },
    researchCampaignTask: { findMany: async () => {
      calls.push("tasks");
      return [{ id: taskId, taskIndex: 0, status: "RUNNING",
        attempts: 1, leaseUntil, observedCount: 0, lastErrorCode: null }];
    } },
    auditEvent: { findMany: async () => {
      calls.push("audit");
      const reserved = { action: "research.campaign.spend.reserved",
        entityId: reservationId, metadata: { ...ids, taskId } };
      return [reserved, ...(duplicate ? [reserved] : []),
        ...(intent ? [{ action: "research.campaign.dispatch.intent",
          entityId: taskId, metadata: { ...ids, taskId } }] : []),
        ...(receipt ? [{ action: "research.campaign.provider.returned",
          entityId: taskId, metadata: { ...ids, taskId } }] : [])];
    } },
    researchSpendReservation: { findUnique: async () => {
      calls.push("spend");
      return { workspaceId: ids.workspaceId, ownerId: ids.ownerId,
        status: reservation, reservedCents: 3, chargedCents: null };
    } },
  };
  const options = { now: () => clock,
    membership: async () => authorized ? { role: "PARTNER" } : null };
  return { database, options, calls };
}

test("stale running task with open reservation is review-only and never replayed", async () => {
  const f = fixture();
  const result = await inspectDiscoveryLeaseReconciliation(
    f.database, ids, f.options);
  assert.equal(result.status, 200);
  assert.equal(result.requiresManualProviderBillingReview, true);
  assert.equal(result.automaticReplayAllowed, false);
  assert.equal(result.mutatesLedger, false);
  assert.deepEqual(result.entries, [{
    taskIndex: 0, taskStatus: "RUNNING", leaseExpired: true, attempts: 1,
    lastErrorCode: null, reservationTraceUnique: true,
    reservationStatus: "RESERVED", reservedCents: 3,
    conservativeChargedCents: null,
    dispatchIntentRecorded: true, providerReturnedRecorded: false,
    automaticReplayAllowed: false,
  }]);
  assert.deepEqual(f.calls, ["full", "tasks", "audit", "spend"]);
});

test("provider receipt does not automatically settle charge or permit replay", async () => {
  const f = fixture({ receipt: true });
  const result = await inspectDiscoveryLeaseReconciliation(f.database, ids,
    f.options);
  assert.equal(result.entries[0].providerReturnedRecorded, true);
  assert.equal(result.entries[0].reservationStatus, "RESERVED");
  assert.equal(result.automaticReplayAllowed, false);
});

test("legacy missing dispatch intent is still billing-uncertain", async () => {
  const f = fixture({ intent: false });
  const result = await inspectDiscoveryLeaseReconciliation(f.database, ids,
    f.options);
  assert.equal(result.entries[0].dispatchIntentRecorded, false);
  assert.equal(result.requiresManualProviderBillingReview, true);
  assert.equal(result.entries[0].automaticReplayAllowed, false);
});

test("ambiguous reservation trace cannot be treated as a known spend", async () => {
  const f = fixture({ duplicate: true });
  const result = await inspectDiscoveryLeaseReconciliation(f.database, ids,
    f.options);
  assert.equal(result.entries[0].reservationTraceUnique, false);
  assert.equal(result.entries[0].reservationStatus, "UNCONFIRMED");
  assert.ok(!f.calls.includes("spend"));
});

test("revoked authorization and wrong owner cannot expose reconciliation", async () => {
  for (const mode of [{ authorized: false }, { wrongOwner: true }]) {
    const f = fixture(mode);
    const result = await inspectDiscoveryLeaseReconciliation(f.database, ids,
      f.options);
    assert.ok([403, 404].includes(result.status));
    assert.ok(!f.calls.includes("audit"));
    assert.ok(!f.calls.includes("spend"));
  }
});

test("invalid scopes fail before database access", async () => {
  const f = fixture();
  await assert.rejects(
    inspectDiscoveryLeaseReconciliation(f.database,
      { ...ids, campaignId: "not-a-cuid" }, f.options), TypeError);
  assert.deepEqual(f.calls, []);
});
