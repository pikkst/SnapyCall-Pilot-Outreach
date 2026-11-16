import test from "node:test";
import assert from "node:assert/strict";
import { boundedRetryDelayMs, classifyTaskFailure, claimResearchTask,
  completeResearchTask, failResearchTask } from "../server/research-campaign-leases.js";

const now = new Date("2026-11-16T14:00:00.000Z");
const scope = { campaignId: "cmabcdefghijklmnopqrstu", workspaceId: "cmabcdefghijklmnopqrstv",
  ownerId: "cmabcdefghijklmnopqrstw", now };

test("only transient bounded failures retry and uncertain billing never retries", () => {
  assert.equal(boundedRetryDelayMs(1), 2000);
  assert.equal(boundedRetryDelayMs(2), 4000);
  assert.equal(boundedRetryDelayMs(3), 8000);
  for (const code of ["PROVIDER_429", "PROVIDER_5XX"]) {
    assert.deepEqual(classifyTaskFailure(code, 1, now), {
      status: "QUEUED", nextAttemptAt: new Date(now.getTime() + 2000),
      lastErrorCode: code,
    });
    assert.equal(classifyTaskFailure(code, 3, now).status, "PAUSED");
  }
  for (const code of ["PERMISSION_REVOKED", "BUDGET_EXHAUSTED",
    "BILLING_UNCERTAIN", "PROVIDER_INVALID_RESPONSE"]) {
    const result = classifyTaskFailure(code, 1, now);
    assert.equal(result.status, "PAUSED");
    assert.equal(result.nextAttemptAt, null);
  }
  assert.equal(classifyTaskFailure("secret upstream error", 1, now).lastErrorCode,
    "UNCLASSIFIED");
  assert.throws(() => boundedRetryDelayMs(4));
});

test("claim is scope-locked and returns a finite fenced lease", async () => {
  let reads = 0;
  const db = { $transaction: async handler => handler({
    $queryRaw: async () => ++reads === 1 ? [{ id: scope.campaignId }] :
      [{ id: "task-1", attempts: 0, query: "Source-backed experts", resultLimit: 10 }],
    researchCampaignTask: { update: async ({ data }) => {
      assert.equal(data.status, "RUNNING");
      assert.equal(data.attempts.increment, 1);
    } },
    researchCampaign: { updateMany: async () => ({ count: 1 }) },
  }) };
  const result = await claimResearchTask(db, scope);
  assert.equal(reads, 2);
  assert.equal(result.taskId, "task-1");
  assert.equal(result.attempt, 1);
  assert.equal(result.limit, 10);
  assert.equal(result.leaseUntil.getTime() - now.getTime(), 120000);
  assert.match(result.leaseToken, /^[a-f0-9-]{36}$/);
});

test("no eligible campaign or task cannot create a lease", async () => {
  const db = { $transaction: async fn => fn({
    $queryRaw: async () => [],
  }) };
  assert.equal(await claimResearchTask(db, scope), null);
  await assert.rejects(() => claimResearchTask(db, { ...scope, workspaceId: "wrong" }));
});

test("completion requires matching lease, status and bounded result count", async () => {
  const claim = { ...scope, taskId: "task-1", leaseToken: "token", limit: 10, attempt: 1 };
  let where;
  const tx = { researchCampaignTask: { updateMany: async input => {
    where = input.where; return { count: 1 };
  } } };
  assert.equal(await completeResearchTask(tx, claim, { observedCount: 8, now }), true);
  assert.equal(where.leaseToken, "token");
  assert.equal(where.leaseUntil.gt, now);
  assert.equal(where.campaign.ownerId, claim.ownerId);
  await assert.rejects(() => completeResearchTask(tx, claim, { observedCount: 11, now }));
  tx.researchCampaignTask.updateMany = async () => ({ count: 0 });
  assert.equal(await completeResearchTask(tx, claim, { observedCount: 1, now }), false);
  const result = await failResearchTask(tx, claim, "PROVIDER_429", now);
  assert.equal(result.applied, false);
  assert.equal(result.status, "QUEUED");
});
