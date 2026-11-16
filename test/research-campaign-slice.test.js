import test from "node:test";
import assert from "node:assert/strict";
import {
  validateResearchSliceInput, runBoundedCampaignSlice,
} from "../server/research-campaign-slice.js";

test("execution accepts only explicit bounded paid slice sizes", () => {
  assert.deepEqual(validateResearchSliceInput({}), { maxTasks: 1 });
  assert.deepEqual(validateResearchSliceInput({ maxTasks: 3 }), { maxTasks: 3 });
  for (const invalid of [null, [], { maxTasks: 0 }, { maxTasks: 4 },
    { maxTasks: 1.5 }, { maxTasks: "3" }, { maxTasks: 2, workspaceId: "hijack" }]) {
    assert.throws(() => validateResearchSliceInput(invalid), TypeError);
  }
});

test("3-task slice executes only explicitly requested tasks and never sends", async () => {
  let calls = 0;
  const result = await runBoundedCampaignSlice({ maxTasks: 3 }, {
    runTask: async () => {
      calls++;
      return { status: "COMPLETED", taskId: "task-" + calls,
        attempted: true, uniqueAdded: 10, duplicates: 0 };
    },
  });
  assert.equal(calls, 3);
  assert.equal(result.status, "SLICE_COMPLETED");
  assert.equal(result.completedTasks, 3);
  assert.equal(result.attemptedTasks, 3);
  assert.equal(result.sendingEnabled, false);
  assert.deepEqual(result.taskResults.map(x => x.taskId),
    ["task-1", "task-2", "task-3"]);
});

test("uncertain charge stops before a third task and never retries", async () => {
  let calls = 0;
  const outcome = await runBoundedCampaignSlice({ maxTasks: 3 }, {
    runTask: async () => {
      calls++;
      return calls === 1 ?
        { status: "COMPLETED", taskId: "task-1", uniqueAdded: 10, duplicates: 0 } :
        { status: "RECONCILIATION_REQUIRED", attempted: true,
          code: "RESEARCH_SPEND_RECONCILIATION_REQUIRED" };
    },
  });
  assert.equal(calls, 2);
  assert.equal(outcome.status, "REVIEW_REQUIRED");
  assert.equal(outcome.completedTasks, 1);
  assert.equal(outcome.attemptedTasks, 2);
  assert.equal(outcome.code, "RESEARCH_SPEND_RECONCILIATION_REQUIRED");
  assert.equal(outcome.sendingEnabled, false);
});

test("no-ready-task is not mistaken for successful 100-person campaign", async () => {
  let calls = 0;
  const outcome = await runBoundedCampaignSlice({ maxTasks: 3 }, {
    runTask: async () => {
      calls++;
      return { status: "NO_READY_TASK", attempted: false };
    },
  });
  assert.equal(calls, 1);
  assert.equal(outcome.status, "NO_READY_TASK");
  assert.equal(outcome.completedTasks, 0);
  assert.equal(outcome.code, "RESEARCH_NO_READY_TASK");
});

test("later exception preserves prior successful commits, with no replay", async () => {
  let calls = 0;
  const outcome = await runBoundedCampaignSlice({ maxTasks: 3 }, {
    runTask: async () => {
      calls++;
      if (calls === 2) throw new Error("Provider secret");
      return { status: "COMPLETED", taskId: "task-1",
        uniqueAdded: 7, duplicates: 3 };
    },
  });
  assert.equal(calls, 2);
  assert.equal(outcome.status, "REVIEW_REQUIRED");
  assert.equal(outcome.completedTasks, 1);
  assert.equal(outcome.code, "RESEARCH_SLICE_HALTED");
  assert.doesNotMatch(JSON.stringify(outcome), /Provider secret/);
});

test("stops on revoked membership, PAUSED and failed lease reconciliation", async () => {
  for (const outcome of [
    { status: "PAUSED", attempted: false, code: "PERMISSION_REVOKED" },
    { status: "RECOVERY_REQUIRED", attempted: true, code: "TASK_LEASE_STATE_UNCONFIRMED" },
  ]) {
    let calls = 0;
    const result = await runBoundedCampaignSlice({ maxTasks: 3 }, {
      runTask: async () => { calls++; return outcome; },
    });
    assert.equal(calls, 1);
    assert.equal(result.status, "REVIEW_REQUIRED");
    assert.equal(result.code, outcome.code);
    assert.equal(result.completedTasks, 0);
  }
});
