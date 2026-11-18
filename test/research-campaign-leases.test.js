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
    $queryRaw: async () => {
      reads++;
      if (reads === 1) return [{ id: scope.campaignId }];
      if (reads === 2) return [{ targetCount: 100, uniqueCount: 0 }];
      return [{ id: "task-1", attempts: 0,
        query: "Source-backed experts", resultLimit: 10 }];
    },
    researchCampaignTask: { count: async () => 0,
      update: async ({ data }) => {
      assert.equal(data.status, "RUNNING");
      assert.equal(data.attempts.increment, 1);
    } },
    researchCampaign: { updateMany: async () => ({ count: 1 }) },
  }) };
  const result = await claimResearchTask(db, scope);
  assert.equal(reads, 3);
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

test("terminal no-grounding completion is fenced and stores a zero-evidence diagnostic", async () => {
  const claim = { ...scope, taskId: "task-1", leaseToken: "token", limit: 10 };
  let input;
  const tx = { researchCampaignTask: { updateMany: async value => {
    input = value; return { count: 1 };
  } } };
  assert.equal(await completeResearchTask(tx, claim, {
    observedCount: 0, completionCode: "NO_VERIFIABLE_GROUNDING", now,
  }), true);
  assert.equal(input.where.leaseToken, "token");
  assert.equal(input.data.status, "COMPLETED");
  assert.equal(input.data.lastErrorCode, "NO_VERIFIABLE_GROUNDING");
  assert.equal(input.data.observedCount, 0);
  assert.equal(await completeResearchTask(tx, claim, {
    observedCount: 0, completionCode: "NO_USABLE_STRUCTURED_OUTPUT", now,
  }), true);
  assert.equal(input.data.lastErrorCode, "NO_USABLE_STRUCTURED_OUTPUT");
  for (const invalid of [
    { observedCount: 1, completionCode: "NO_USABLE_STRUCTURED_OUTPUT" },
    { observedCount: 1, completionCode: "NO_VERIFIABLE_GROUNDING" },
    { observedCount: 0, completionCode: "BILLING_UNCERTAIN" },
  ]) {
    await assert.rejects(() => completeResearchTask(tx, claim,
      { ...invalid, now }), TypeError);
  }
});

test("target met prevents a new paid lease and closes only fully settled tasks", async () => {
  const events = [];
  const db = { $transaction: async fn => fn({
    $queryRaw: async strings => {
      const sql = strings.join("?");
      return sql.includes('COUNT(o."id")')
        ? [{ targetCount: 100, uniqueCount: 104 }]
        : [{ id: scope.campaignId }];
    },
    researchCampaignTask: {
      count: async () => 0,
      updateMany: async ({ data }) => { events.push("tasks-" + data.status); return { count: 20 }; },
      update: async () => { throw new Error("Paid task must not be claimed"); },
    },
    researchCampaign: { updateMany: async ({ data }) => {
      events.push("campaign-" + data.status); return { count: 1 };
    } },
  }) };
  assert.equal(await claimResearchTask(db, scope), null);
  assert.deepEqual(events, ["tasks-CANCELLED", "campaign-COMPLETED"]);
});

test("unsettled in-flight task blocks terminal state even when target is reached", async () => {
  let writes = 0;
  const db = { $transaction: async fn => fn({
    $queryRaw: async strings => strings.join("?").includes('COUNT(o."id")') ?
      [{ targetCount: 100, uniqueCount: 101 }] : [{ id: scope.campaignId }],
    researchCampaignTask: {
      count: async () => 1,
      updateMany: async () => { writes++; },
    },
    researchCampaign: { updateMany: async () => { writes++; } },
  }) };
  assert.equal(await claimResearchTask(db, scope), null);
  assert.equal(writes, 0);
});

test("unresolved paid task prevents another provider claim before reservation", async () => {
  let reservationCalled = false;
  const db = { $transaction: async fn => fn({
    $queryRaw: async strings => strings.join("?").includes('COUNT(o."id")')
      ? [{ targetCount: 100, uniqueCount: 20 }]
      : [{ id: scope.campaignId }],
    researchCampaignTask: {
      count: async ({ where }) => {
        assert.equal(where.campaignId, scope.campaignId);
        assert.equal(where.OR[0].status.in[0], "PAUSED");
        assert.equal(where.OR[1].status, "RUNNING");
        return 1;
      },
      update: async () => { throw new Error("Must not claim"); },
    },
  }) };
  const result = await claimResearchTask(db, {
    ...scope, reserveInTransaction: async () => { reservationCalled = true; },
  });
  assert.equal(result, null);
  assert.equal(reservationCalled, false);
});

test("full-run claim may proceed after 100 raw names but never after 250 saved observations", async () => {
  for (const uniqueCount of [101, 250]) {
    const actions = [];
    const db = { $transaction: async handler => handler({
      researchFullRun: { findUnique: async () => ({
        status: "DISCOVERY", ownerId: scope.ownerId,
        workspaceId: scope.workspaceId,
      }) },
      $queryRaw: async parts => {
        const sql = parts.join("?");
        if (sql.includes('COUNT(o."id")'))
          return [{ targetCount: 100, uniqueCount }];
        if (sql.includes('FROM "ResearchCampaignTask"'))
          return [{ id: "task-25", attempts: 0,
            query: "Distinct approved public profile search",
            resultLimit: 10 }];
        return [{ id: scope.campaignId }];
      },
      researchCampaignTask: {
        count: async () => 0,
        update: async ({ data }) => {
          actions.push(data.status);
        },
      },
      researchCampaign: {
        updateMany: async ({ data }) => {
          actions.push("campaign:" + data.status);
          return { count: 1 };
        },
      },
    }) };
    const result = await claimResearchTask(db, scope);
    if (uniqueCount === 101) {
      assert.equal(result.taskId, "task-25");
      assert.deepEqual(actions, ["RUNNING", "campaign:RUNNING"]);
    } else {
      assert.equal(result, null);
      assert.deepEqual(actions, []);
    }
  }
});
