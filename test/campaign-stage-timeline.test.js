import test from "node:test";
import assert from "node:assert/strict";
import { campaignStageTimeline } from "../src/campaign-stage-timeline.js";

function snapshot(overrides = {}) {
  return { targetCount: 100, uniqueSourcedCandidates: 10,
    operationalState: "READY", needsReconciliation: false,
    tasks: { running: 0, queued: 12, completed: 3, paused: 0,
      failed: 0, cancelled: 0 }, ...overrides };
}

test("only a server-reported running discovery task is animated as active", () => {
  assert.equal(campaignStageTimeline(snapshot())[0].status, "QUEUED");
  const stages = campaignStageTimeline(snapshot({
    tasks: { ...snapshot().tasks, running: 1 },
  }));
  assert.equal(stages[0].status, "ACTIVE");
  assert.equal(stages[1].status, "REVIEW_AVAILABLE");
  assert.equal(stages[2].status, "MANUAL_ONLY");
  assert.equal(stages[3].status, "MANUAL_ONLY");
  assert.equal(stages[4].status, "DISABLED");
});

test("100 discovery observations never imply 100 verified email contacts", () => {
  const stages = campaignStageTimeline(snapshot({
    uniqueSourcedCandidates: 101, operationalState: "COMPLETED",
    tasks: { ...snapshot().tasks, queued: 0, completed: 16 },
  }));
  assert.equal(stages[0].status, "FINISHED");
  assert.match(stages[0].detail, /Not verified contacts/);
  assert.equal(stages[2].status, "MANUAL_ONLY");
  assert.equal(stages[4].status, "DISABLED");
});

test("billing or lease uncertainty is not shown as normal progress", () => {
  const stages = campaignStageTimeline(snapshot({
    needsReconciliation: true, operationalState: "PAUSED_REVIEW",
  }));
  assert.equal(stages[0].status, "NEEDS_ATTENTION");
});

test("projection rejects unavailable progress without inventing a stage", () => {
  assert.throws(() => campaignStageTimeline(null), TypeError);
  assert.throws(() => campaignStageTimeline(snapshot({ targetCount: 0 })), TypeError);
});
