import test from "node:test";
import assert from "node:assert/strict";
import { campaignInput, planResearchCampaign } from "../server/research-campaign-planner.js";

const input = {
  query: "Find experienced AI automation consultants working internationally",
  targetCount: 120,
  idempotencyKey: "6c8d3e48-14fc-4f67-b0c1-e70cf9c48fad",
};

test("planner partitions worldwide research into reproducible bounded tasks", () => {
  const plan = planResearchCampaign(input);
  assert.equal(plan.planVersion, "ai62-planner-v1");
  assert.equal(plan.maxTasks, 24);
  assert.equal(plan.maxCandidateObservations, 240);
  assert.equal(plan.targetCount, 120);
  assert.equal(plan.providerCallsAuthorized, false);
  assert.equal(plan.sendEnabled, false);
  assert.deepEqual(plan, planResearchCampaign(input));
  assert.equal(new Set(plan.tasks.map(task => task.key)).size, 24);
  assert.equal(new Set(plan.tasks.map(task => task.query)).size, 24);
  for (const [index, task] of plan.tasks.entries()) {
    assert.equal(task.index, index);
    assert.equal(task.limit, 10);
    assert.ok(task.query.length <= 350);
    assert.equal(task.key.length, 64);
    assert.match(task.query, /AI automation consultants/);
  }
});

test("planner has a fixed finite task budget regardless of desired count", () => {
  for (const targetCount of [20, 100, 200]) {
    const plan = planResearchCampaign({ ...input, targetCount });
    assert.equal(plan.tasks.length, 24);
    assert.equal(plan.tasks.reduce((sum, task) => sum + task.limit, 0), 240);
  }
});

test("planner rejects malformed, overlong and uncontrolled inputs before any execution", () => {
  const invalid = [
    { ...input, targetCount: 201 },
    { ...input, targetCount: 0 },
    { ...input, query: "short" },
    { ...input, query: "A".repeat(240) },
    { ...input, idempotencyKey: "not-a-uuid" },
    { ...input, provider: "unknown" },
    { ...input, workspaceId: "another-workspace" },
  ];
  for (const value of invalid) assert.throws(() => planResearchCampaign(value));
  assert.equal(campaignInput.safeParse(input).success, true);
});

test("planner does not mutate caller inputs or rely on non-deterministic state", () => {
  const before = structuredClone(input);
  planResearchCampaign(input);
  assert.deepEqual(input, before);
  const a = planResearchCampaign(input);
  const b = planResearchCampaign({ ...input, idempotencyKey:
    "9dbb60b2-20a9-4c9a-8b7a-8b4ccf299912" });
  assert.deepEqual(a.tasks, b.tasks);
});
