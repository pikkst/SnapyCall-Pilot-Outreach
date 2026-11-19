import test from "node:test";
import assert from "node:assert/strict";
import { startApprovedCampaignWorker } from "../server/research-approved-runner.js";

function controlledWorker(runTick) {
  let callback;
  let canceled = false;
  const stop = startApprovedCampaignWorker({}, {
    encryptionKey: "testing-only-encryption-key", intervalMs: 5000,
    runTick,
    schedule: fn => { callback = fn; return 123; },
    cancel: handle => { assert.equal(handle, 123); canceled = true; },
  });
  return { startTick: () => callback(), stop, wasCanceled: () => canceled };
}

test("shutdown drains active provider work without starting another paid task", async () => {
  let finish;
  let started = 0;
  const worker = controlledWorker(() => {
    started++;
    return new Promise(resolve => { finish = resolve; });
  });
  worker.startTick();
  await Promise.resolve();
  assert.equal(started, 1);
  let drained = false;
  const pending = worker.stop().then(() => { drained = true; });
  assert.equal(worker.wasCanceled(), true);
  worker.startTick();
  await Promise.resolve();
  assert.equal(started, 1);
  assert.equal(drained, false);
  finish({ status: "COMPLETED" });
  await pending;
  assert.equal(drained, true);
  worker.startTick();
  await Promise.resolve();
  assert.equal(started, 1);
});

test("shutdown is idempotent when no paid task is running", async () => {
  let called = 0;
  const worker = controlledWorker(async () => { called++; });
  await worker.stop();
  await worker.stop();
  worker.startTick();
  await Promise.resolve();
  assert.equal(called, 0);
});

test("provider errors do not reject the shutdown drain or replay the task", async () => {
  let fail;
  let runs = 0;
  const worker = controlledWorker(() => {
    runs++;
    return new Promise((_resolve, reject) => { fail = reject; });
  });
  worker.startTick();
  await Promise.resolve();
  const drained = worker.stop();
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    fail(new Error("private provider data must never be logged"));
    await drained;
  } finally {
    console.warn = originalWarn;
  }
  worker.startTick();
  await Promise.resolve();
  assert.equal(runs, 1);
});
