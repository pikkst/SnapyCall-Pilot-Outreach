import test from "node:test";
import assert from "node:assert/strict";
import { consecutiveQualityFailures, shouldStopForQuality,
  MAX_CONSECUTIVE_QUALITY_FAILURES } from "../server/research-quality-gate.js";

const failed = taskIndex => ({
  taskIndex, status: "COMPLETED", observedCount: 0,
});
const valid = taskIndex => ({
  taskIndex, status: "COMPLETED", observedCount: 2,
});
const queued = taskIndex => ({
  taskIndex, status: "QUEUED", observedCount: 0,
});

test("three consecutive completed zero-evidence tasks block a campaign", () => {
  assert.equal(MAX_CONSECUTIVE_QUALITY_FAILURES, 3);
  assert.equal(consecutiveQualityFailures([
    failed(0), failed(1), failed(2), queued(3), queued(4),
  ]), 3);
  assert.equal(shouldStopForQuality([
    failed(2), failed(1), failed(0),
  ]), true);
});

test("a valid result fully resets the consecutive failure sequence", () => {
  assert.equal(consecutiveQualityFailures([
    failed(0), failed(1), valid(2), failed(3), failed(4),
  ]), 2);
  assert.equal(shouldStopForQuality([
    failed(0), failed(1), valid(2), failed(3), failed(4), valid(5),
    failed(6), failed(7),
  ]), false);
  assert.equal(shouldStopForQuality([
    failed(0), failed(1), valid(2), failed(3), failed(4), failed(5),
  ]), true);
});

test("an unsettled, cancelled or skipped task cannot be hidden to invent a streak", () => {
  for (const status of ["PAUSED", "RUNNING", "CANCELLED", "FAILED"]) {
    assert.equal(shouldStopForQuality([
      failed(0), { taskIndex: 1, status, observedCount: 0 },
      failed(2), failed(3),
    ]), false);
  }
  assert.equal(shouldStopForQuality([failed(0), failed(2), failed(3)]), false);
  assert.equal(shouldStopForQuality([failed(0), failed(1), failed(3)]), false);
  assert.equal(consecutiveQualityFailures([queued(0), queued(1)]), 0);
});

test("read-only snapshots lacking task indexes cannot fabricate a stop", () => {
  assert.equal(consecutiveQualityFailures([
    { status: "COMPLETED", observedCount: 0 },
    { status: "COMPLETED", observedCount: 0 },
    { status: "COMPLETED", observedCount: 0 },
  ]), 0);
  assert.throws(() => consecutiveQualityFailures(null), TypeError);
  assert.throws(() => consecutiveQualityFailures([
    { taskIndex: 0, status: "COMPLETED", observedCount: -1 },
  ]), TypeError);
});
