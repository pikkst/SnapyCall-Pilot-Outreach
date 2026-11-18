import test from "node:test";
import assert from "node:assert/strict";
import { nextAdaptiveDiscoveryTask, maybeAppendAdaptiveDiscoveryTask }
  from "../server/research-adaptive-discovery.js";
import { planResearchCampaign } from "../server/research-campaign-planner.js";

const input = {
  query: "Find experienced independent AI automation consultants",
  targetCount: 100,
  idempotencyKey: "6c8d3e48-14fc-4f67-b0c1-e70cf9c48fad",
};
const scope = {
  campaignId: "cmabcdefghijklmnopqrstu",
  workspaceId: "cmabcdefghijklmnopqrstv",
  ownerId: "cmabcdefghijklmnopqrstw",
};
const now = new Date("2026-11-18T16:20:00Z");
const plan = planResearchCampaign(input);
const campaign = { ...input, planVersion: plan.planVersion };

function fixture({ budgetCalls = 100, startedTasks = 24,
  committedCents = 240, maxCents = 1000,
  observations = 80, existingTasks = 24, status = "DISCOVERY",
  access = true, price = 10, expiresAt = new Date(now.getTime() + 100000),
  previousIndex = existingTasks - 1,
} = {}) {
  const records = [];
  const tx = {
    researchFullRun: { findUnique: async () => status ? {
      status, ownerId: access ? scope.ownerId : "another-owner",
      workspaceId: scope.workspaceId,
      maxDiscoveryCalls: budgetCalls, expiresAt,
    } : null },
    researchCampaignRun: { findUnique: async () => ({
      ownerId: scope.ownerId, workspaceId: scope.workspaceId,
      status: "RUNNING", maxTasks: budgetCalls,
      startedTasks, maxWorstCaseCents: maxCents,
      committedWorstCaseCents: committedCents,
      worstCasePerCallCents: price,
      expiresAt,
    }) },
    researchCampaignTask: {
      count: async () => existingTasks,
      findFirst: async () => ({ taskIndex: previousIndex }),
      create: async ({ data }) => {
        records.push(data);
        return data;
      },
    },
  };
  const params = { ...scope, campaign, observedCount: observations, now };
  return { tx, params, records };
}

test("replenishment indexes are deterministic and differ from original tasks", () => {
  const a = nextAdaptiveDiscoveryTask(campaign, 24);
  const b = nextAdaptiveDiscoveryTask(campaign, 24);
  const other = nextAdaptiveDiscoveryTask(campaign, 25);
  const later = nextAdaptiveDiscoveryTask(campaign, 48);
  assert.deepEqual(a, b);
  assert.equal(a.index, 24);
  assert.equal(a.limit, 10);
  assert.notEqual(a.key, plan.tasks[0].key);
  assert.notEqual(a.key, other.key);
  assert.notEqual(a.query, later.query);
  assert.equal(new Set(Array.from({ length: 226 }, (_, i) =>
    nextAdaptiveDiscoveryTask(campaign, 24 + i).key)).size, 226);
  for (const bad of [-1, 0, 23, 250, 1000]) {
    assert.throws(() => nextAdaptiveDiscoveryTask(campaign, bad), TypeError);
  }
  assert.throws(() => nextAdaptiveDiscoveryTask({
    ...campaign, planVersion: "unknown",
  }, 24), TypeError);
});

test("one new queued task is created only within frozen approval and campaign lock", async () => {
  const f = fixture();
  const result = await maybeAppendAdaptiveDiscoveryTask(f.tx, f.params);
  assert.equal(result.appended, true);
  assert.equal(result.taskIndex, 24);
  assert.equal(f.records.length, 1);
  assert.equal(f.records[0].status, "QUEUED");
  assert.equal(f.records[0].taskKey, nextAdaptiveDiscoveryTask(campaign, 24).key);
});

test("source or discovery spend cannot expand beyond original approval", async () => {
  for (const [opts, expected] of [
    [{ status: null }, false],
    [{ status: "SOURCE_RUNNING" }, false],
    [{ access: false }, false],
    [{ observations: 250 }, false],
    [{ budgetCalls: 24 }, false],
    [{ startedTasks: 100 }, false],
    [{ committedCents: 995 }, false],
    [{ expiresAt: new Date(now.getTime() - 1) }, false],
    [{ previousIndex: 30 }, false],
    [{ existingTasks: 250 }, false],
  ]) {
    const f = fixture(opts);
    const result = await maybeAppendAdaptiveDiscoveryTask(f.tx, f.params);
    assert.equal(result.appended, expected);
    assert.deepEqual(f.records, []);
  }
});

test("first 24 tasks are not recreated and do not gain new paid entitlement", async () => {
  const f = fixture({ existingTasks: 23 });
  const result = await maybeAppendAdaptiveDiscoveryTask(f.tx, f.params);
  assert.equal(result.appended, false);
  assert.deepEqual(f.records, []);
});
