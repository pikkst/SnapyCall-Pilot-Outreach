import test from "node:test";
import assert from "node:assert/strict";
import { runApprovedCampaignBatch } from "../src/campaign-batch.js";

const ready = () => ({
  operationalState: "READY", needsReconciliation: false, budgetReady: true,
});

test("one explicit approval runs at most five sequential paid calls, not a hidden schedule", async () => {
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const progress = [];
  const result = await runApprovedCampaignBatch({
    maxTasks: 5,
    readState: async () => ready(),
    execute: async () => {
      active++;
      maxActive = Math.max(active, maxActive);
      calls++;
      await Promise.resolve();
      active--;
    },
    onProgress: completed => progress.push(completed),
  });
  assert.equal(result.status, "BATCH_COMPLETED");
  assert.equal(result.completed, 5);
  assert.equal(calls, 5);
  assert.equal(maxActive, 1);
  assert.deepEqual(progress, [1, 2, 3, 4, 5]);
});

test("missing permission, budget or paused campaign always stops before next paid call", async () => {
  for (const state of [
    { ...ready(), operationalState: "PAUSED_REVIEW" },
    { ...ready(), needsReconciliation: true },
    { ...ready(), budgetReady: false },
    { ...ready(), operationalState: "COMPLETED" },
  ]) {
    let calls = 0;
    const out = await runApprovedCampaignBatch({
      maxTasks: 5,
      readState: async () => calls > 0 ? state : ready(),
      execute: async () => { calls++; },
    });
    assert.equal(calls, 1);
    assert.deepEqual(out, { status: "NOT_READY", completed: 1 });
  }
});

test("API rejection, timeout or unknown charge outcome is NEVER replayed", async () => {
  let calls = 0;
  const out = runApprovedCampaignBatch({
    maxTasks: 5,
    readState: async () => ready(),
    execute: async () => {
      calls++;
      if (calls === 2) throw new Error("Uncertain billing");
    },
  });
  await assert.rejects(out, /Uncertain billing/);
  assert.equal(calls, 2);
});

test("stop button waits for ongoing call but never starts the following one", async () => {
  let calls = 0;
  let stop = false;
  const out = await runApprovedCampaignBatch({
    maxTasks: 5,
    readState: async () => ready(),
    execute: async () => { calls++; stop = true; },
    shouldStop: () => stop,
  });
  assert.deepEqual(out, { status: "STOPPED", completed: 1 });
  assert.equal(calls, 1);
});

test("rejects invalid batch quantities and client callbacks before any cost", async () => {
  for (const maxTasks of [0, 6, -1, 2.5, "5", null]) {
    let calls = 0;
    await assert.rejects(() => runApprovedCampaignBatch({
      maxTasks, readState: async () => ready(),
      execute: async () => { calls++; },
    }), TypeError);
    assert.equal(calls, 0);
  }
});
