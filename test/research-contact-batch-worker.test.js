import test from "node:test";
import assert from "node:assert/strict";
import { claimContactBatchItem, finishContactBatchItem,
  reconcileExpiredContactBatchItem, tickContactBatch,
  finalizeContactBatch } from "../server/research-contact-batch-worker.js";

const scope = {
  campaignId: "cmabcdefghijklmnopqrstu",
  workspaceId: "cmabcdefghijklmnopqrstv",
  ownerId: "cmabcdefghijklmnopqrstw",
  batchId: "cmabcdefghijklmnopqrszzz",
};
const id = "cmabcdefghijklmnopqrs1";
const observationId = "cmabcdefghijklmnopqrs2";
const candidateId = "cmabcdefghijklmnopqrs3";
const digest = "a".repeat(64);
const now = new Date("2026-11-18T15:30:00Z");

function fixture({ expired = false, candidateLinked = false,
  revoked = false, failedEvidence = false, initialStatus = "QUEUED" } = {}) {
  const actions = [];
  const batch = { id: scope.batchId, ...scope,
    status: "APPROVED", itemCount: 1 };
  const item = {
    id, batchId: scope.batchId, observationId,
    expectedDigest: digest, status: initialStatus,
    attempts: initialStatus === "QUEUED" ? 0 : 1,
    leaseToken: initialStatus === "RUNNING" ? "old" : null,
    leaseUntil: expired ? new Date(now.getTime() - 1000)
      : new Date(now.getTime() + 40000),
  };
  const tx = {
    $queryRaw: async chunks => {
      const sql = chunks.join("?");
      if (sql.includes('FROM "PartnerMembership"'))
        return revoked ? [] : [{ revokedAt: null }];
      if (sql.includes('FROM "ResearchCampaign"'))
        return [{ id: scope.campaignId }];
      throw Error("Unexpected SQL");
    },
    researchContactBatch: {
      findUnique: async () => batch,
      updateMany: async ({ data }) => {
        actions.push("batch-" + data.status);
        batch.status = data.status;
        return { count: 1 };
      },
    },
    researchContactBatchItem: {
      count: async ({ where }) => where.status?.in?.includes(item.status) ? 1 : 0,
      findFirst: async ({ where }) => {
        if (where.status === "RUNNING") {
          return item.status === "RUNNING" && item.leaseUntil <= now ? item : null;
        }
        return item.status === "QUEUED" ? item : null;
      },
      findMany: async () => [item],
      updateMany: async ({ data }) => {
        actions.push("item-" + data.status);
        Object.assign(item, data);
        if (data.attempts?.increment) item.attempts = 1;
        return { count: 1 };
      },
    },
    researchCampaignObservation: {
      findFirst: async () => ({
        candidateId: candidateLinked ? candidateId : null,
      }),
    },
    candidateDirectEmailObservation: {
      findFirst: async () => candidateLinked && !failedEvidence ?
        { candidateId } : null,
    },
    auditEvent: { create: async ({ data }) => {
      actions.push("audit");
      assert.equal(data.metadata.sendingEnabled ?? false, false);
      assert.equal(JSON.stringify(data.metadata).includes("expert@example"), false);
    } },
  };
  const db = {
    researchContactBatch: { findFirst: async () => batch },
    $transaction: async fn => fn(tx),
  };
  return { db, actions, batch, item };
}

test("claims one existing reviewed pair, then blocks a concurrent second claim", async () => {
  const f = fixture();
  const claim = await claimContactBatchItem(f.db, scope, { now });
  assert.equal(claim.status, "CLAIMED");
  assert.equal(claim.observationId, observationId);
  assert.equal(claim.expectedDigest, digest);
  assert.equal(f.item.status, "RUNNING");
  const again = await claimContactBatchItem(f.db, scope, { now });
  assert.equal(again.code, "CONTACT_BATCH_RECONCILIATION_REQUIRED");
});

test("fresh exact digest contact save is fenced, idempotent and not send-eligible", async () => {
  const f = fixture();
  const claim = await claimContactBatchItem(f.db, scope, { now });
  const outcome = await finishContactBatchItem(f.db, claim, {
    status: 201, code: "CONTACT_CREATED_REVIEW_PENDING", candidateId,
  }, { now });
  assert.equal(outcome.status, "SAVED");
  assert.equal(outcome.sendingEnabled, false);
  assert.equal(f.item.candidateId, candidateId);
  assert.equal(f.item.status, "SAVED");
});

test("unproved Candidate ID never marks an item saved", async () => {
  const f = fixture();
  const claim = await claimContactBatchItem(f.db, scope, { now });
  const outcome = await finishContactBatchItem(f.db, claim, {
    status: 201, code: "CONTACT_CREATED_REVIEW_PENDING",
  }, { now });
  assert.equal(outcome.status, "PAUSED");
  assert.equal(f.item.candidateId, null);
});

test("changed profile evidence becomes an exception, not a green contact", async () => {
  const f = fixture();
  const claim = await claimContactBatchItem(f.db, scope, { now });
  const result = await finishContactBatchItem(f.db, claim, {
    status: 409, code: "FRESH_PERSON_EMAIL_EVIDENCE_REQUIRED",
  }, { now });
  assert.equal(result.status, "REVIEW_REQUIRED");
  assert.equal(result.sendingEnabled, false);
});

test("stale claimed item is recovered only from the exact existing accepted digest", async () => {
  for (const linked of [true, false]) {
    const f = fixture({ initialStatus: "RUNNING",
      expired: true, candidateLinked: linked });
    const result = await reconcileExpiredContactBatchItem(f.db, scope, { now });
    assert.equal(result.status, linked ? "SAVED" : "PAUSED");
    assert.equal(f.item.candidateId, linked ? candidateId : null);
  }
});

test("batch worker invokes existing reviewer intake once per bounded tick", async () => {
  const f = fixture();
  let invocations = 0;
  const result = await tickContactBatch(f.db, {
    now: () => now,
    accept: async (_, request) => {
      invocations++;
      assert.equal(request.expectedDigest, digest);
      assert.equal(request.confirmsExactPersonEmailPair, true);
      return { status: 201, code: "CONTACT_CREATED_REVIEW_PENDING", candidateId };
    },
  });
  assert.equal(result.status, "SAVED");
  assert.equal(invocations, 1);
});

test("terminal batch reports only confirmed Candidate links", async () => {
  const f = fixture({ initialStatus: "SAVED" });
  const result = await finalizeContactBatch(f.db, scope);
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.saved, 1);
  assert.equal(result.unresolved, 0);
});

test("revoked membership prevents claims and no contact is created", async () => {
  const f = fixture({ revoked: true });
  const result = await claimContactBatchItem(f.db, scope, { now });
  assert.equal(result.code, "WORKSPACE_ACCESS_REVOKED");
  assert.deepEqual(f.actions, []);
});
