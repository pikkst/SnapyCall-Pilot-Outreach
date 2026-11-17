import test from "node:test";
import assert from "node:assert/strict";
import {
  runApprovedCampaignBatch, MAX_APPROVED_CAMPAIGN_BATCH_TASKS,
  MIN_START_INTERVAL_MS, ResearchPacingWait, MAX_PACING_WAITS_PER_TASK,
} from "../src/campaign-batch.js";

const ready = () => ({
  operationalState: "READY", needsReconciliation: false, budgetReady: true,
});
const fastClock = () => {
  let time = 1000;
  const delays = [];
  return {
    now: () => time,
    wait: async ms => { delays.push(ms); time += ms; },
    delays,
  };
};

test("one approval executes all 24 planned tasks sequentially and under rate limit", async () => {
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  let latest = 0;
  const progress = [];
  const clock = fastClock();
  const result = await runApprovedCampaignBatch({
    maxTasks: 24, now: clock.now, wait: clock.wait,
    readState: async () => ready(),
    execute: async () => {
      active++;
      maxActive = Math.max(active, maxActive);
      calls++;
      await Promise.resolve();
      active--;
    },
    onProgress: completed => {
      latest = completed;
      progress.push(completed);
    },
  });
  assert.deepEqual(result, { status: "RUN_LIMIT_REACHED", completed: 24 });
  assert.equal(calls, 24);
  assert.equal(maxActive, 1);
  assert.equal(latest, 24);
  assert.equal(clock.delays.length, 23);
  assert.ok(clock.delays.every(ms => ms === MIN_START_INTERVAL_MS));
  assert.deepEqual(progress, Array.from({ length: 24 }, (_, i) => i + 1));
  assert.equal(MAX_APPROVED_CAMPAIGN_BATCH_TASKS, 24);
});

test("read-only final status stops at target or PARTIAL, not after five tasks", async () => {
  for (const terminal of ["COMPLETED", "PARTIAL"]) {
    let calls = 0;
    const clock = fastClock();
    const out = await runApprovedCampaignBatch({
      maxTasks: 24, now: clock.now, wait: clock.wait,
      readState: async () =>
        calls >= 8 ? { ...ready(), operationalState: terminal } : ready(),
      execute: async () => { calls++; },
    });
    assert.equal(calls, 8);
    assert.deepEqual(out, {
      status: "NOT_READY", completed: 8, operationalState: terminal,
    });
  }
});

test("paused, billing review and depleted quota stop before another provider call", async () => {
  for (const state of [
    { ...ready(), operationalState: "PAUSED_REVIEW" },
    { ...ready(), needsReconciliation: true },
    { ...ready(), budgetReady: false },
    { ...ready(), operationalState: "WAITING_RETRY" },
  ]) {
    let calls = 0;
    const clock = fastClock();
    const out = await runApprovedCampaignBatch({
      maxTasks: 24, now: clock.now, wait: clock.wait,
      readState: async () => calls > 0 ? state : ready(),
      execute: async () => { calls++; },
    });
    assert.equal(calls, 1);
    assert.deepEqual(out, { status: "NOT_READY", completed: 1,
      operationalState: state.operationalState });
  }
});

test("after a pacing interval recheck campaign state before next charge", async () => {
  const clock = fastClock();
  let reads = 0;
  let calls = 0;
  const out = await runApprovedCampaignBatch({
    maxTasks: 3, now: clock.now, wait: clock.wait,
    readState: async () => {
      reads++;
      return reads === 3 ? { ...ready(), budgetReady: false } : ready();
    },
    execute: async () => { calls++; },
  });
  assert.equal(calls, 1);
  assert.equal(reads, 3);
  assert.equal(out.status, "NOT_READY");
  assert.equal(out.completed, 1);
});

test("unknown provider/network outcome is never retried automatically", async () => {
  let calls = 0;
  const clock = fastClock();
  await assert.rejects(() => runApprovedCampaignBatch({
    maxTasks: 24, now: clock.now, wait: clock.wait,
    readState: async () => ready(),
    execute: async () => {
      calls++;
      if (calls === 2) throw new Error("Unknown charge state");
    },
  }), /Unknown charge state/);
  assert.equal(calls, 2);
});

test("stop can prevent further provider calls even while waiting", async () => {
  const clock = fastClock();
  let calls = 0;
  let stop = false;
  const out = await runApprovedCampaignBatch({
    maxTasks: 24, now: clock.now,
    wait: async ms => { stop = true; await clock.wait(ms); },
    readState: async () => ready(),
    execute: async () => { calls++; },
    shouldStop: () => stop,
  });
  assert.deepEqual(out, { status: "STOPPED", completed: 1 });
  assert.equal(calls, 1);
});

test("invalid limits, types and missing callbacks do not execute provider calls", async () => {
  for (const maxTasks of [0, 25, -1, 2.5, "24", null]) {
    let calls = 0;
    await assert.rejects(() => runApprovedCampaignBatch({
      maxTasks, readState: async () => ready(),
      execute: async () => { calls++; },
    }), TypeError);
    assert.equal(calls, 0);
  }
});

test("last task finalizes PARTIAL and UI receives durable terminal state", async () => {
  let calls = 0;
  const clock = fastClock();
  const outcome = await runApprovedCampaignBatch({
    maxTasks: 2, now: clock.now, wait: clock.wait,
    readState: async () => calls >= 2
      ? { ...ready(), operationalState: "PARTIAL" } : ready(),
    execute: async () => { calls++; },
  });
  assert.equal(calls, 2);
  assert.deepEqual(outcome, {
    status: "NOT_READY", completed: 2, operationalState: "PARTIAL",
  });
});

test("server-confirmed no-dispatch 429 waits and continues the SAME approved run", async () => {
  const clock = fastClock();
  const calls = [];
  const delays = [];
  const result = await runApprovedCampaignBatch({
    maxTasks: 2, now: clock.now, wait: clock.wait,
    readState: async () => ready(),
    execute: async () => {
      calls.push(clock.now());
      if (calls.length === 2) throw new ResearchPacingWait(28);
    },
    onWaiting: delay => delays.push(delay),
  });
  assert.deepEqual(result, { status: "RUN_LIMIT_REACHED", completed: 2 });
  assert.equal(calls.length, 3, "One failed no-dispatch attempt, never extra paid work");
  assert.ok(clock.delays.includes(28_000));
  assert.ok(delays.includes(28_000));
  assert.equal(calls[2] - calls[1], 28_000);
});

test("pacing wait rechecks budget before another dispatch", async () => {
  const clock = fastClock();
  let calls = 0;
  let gated = false;
  const outcome = await runApprovedCampaignBatch({
    maxTasks: 2, now: clock.now,
    wait: async ms => { await clock.wait(ms); if (ms === 19_000) gated = true; },
    readState: async () => gated ? { ...ready(), budgetReady: false } : ready(),
    execute: async () => {
      calls++;
      if (calls === 2) throw new ResearchPacingWait(19);
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(outcome, { status: "NOT_READY", completed: 1,
    operationalState: "READY" });
});

test("stop during a nonbillable pacing wait prevents further requests", async () => {
  const clock = fastClock();
  let stop = false;
  let calls = 0;
  const out = await runApprovedCampaignBatch({
    maxTasks: 2, now: clock.now,
    readState: async () => ready(),
    wait: async ms => {
      await clock.wait(ms);
      if (ms === 21_000) stop = true;
    },
    execute: async () => {
      calls++;
      if (calls === 2) throw new ResearchPacingWait(21);
    },
    shouldStop: () => stop,
  });
  assert.deepEqual(out, { status: "STOPPED", completed: 1 });
  assert.equal(calls, 2);
});

test("repeated server pacing collisions stop at bounded cap", async () => {
  const clock = fastClock();
  let calls = 0;
  const out = await runApprovedCampaignBatch({
    maxTasks: 1, now: clock.now, wait: clock.wait,
    readState: async () => ready(),
    execute: async () => { calls++; throw new ResearchPacingWait(1); },
  });
  assert.deepEqual(out, { status: "WAITING", completed: 0,
    retryAfterSeconds: 1 });
  assert.equal(calls, MAX_PACING_WAITS_PER_TASK + 1);
});

test("network errors and unknown 429s still cannot be retried", async () => {
  const clock = fastClock();
  let calls = 0;
  await assert.rejects(() => runApprovedCampaignBatch({
    maxTasks: 2, now: clock.now, wait: clock.wait,
    readState: async () => ready(),
    execute: async () => { calls++; throw Error("429 without no-dispatch proof"); },
  }), /429 without no-dispatch proof/);
  assert.equal(calls, 1);
  for (const value of [0, -2, 121, 1.5, "12", null, undefined]) {
    assert.throws(() => new ResearchPacingWait(value), TypeError);
  }
});
