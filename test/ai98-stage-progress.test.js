import test from "node:test";
import assert from "node:assert/strict";
import { projectFullRunStageProgress } from "../server/research-run-progress.js";

const fullRun = { maxDiscoveryCalls: 50, maxSourceCalls: 40 };
const counts = (records) => Object.entries(records).map(([emailTriageStatus, id]) =>
  ({ emailTriageStatus, _count: { id } }));
const timing = {
  stages: [
    { key: "SOURCE_PREPARE", startedAt: "2026-11-19T07:46:00Z",
      finishedAt: "2026-11-19T07:46:08Z" },
  ],
};

test("stage counters show real progress and never treat elapsed time as a percent", () => {
  const result = projectFullRunStageProgress({
    fullRun, discoveryRun: { startedTasks: 25 },
    emailCounts: counts({
      UNCHECKED: 10, CHECKING: 2, REVIEW_REQUIRED: 3,
      NO_EMAIL: 5, BLOCKED: 30, UNCERTAIN: 1,
    }), sourceApproval: { startedCalls: 4 }, timing,
  });
  assert.deepEqual(result.DISCOVERY,
    { completed: 25, total: 50, unit: "searches started" });
  assert.deepEqual(result.EMAIL_TRIAGE,
    { completed: 39, total: 51, unit: "profiles inspected" });
  assert.deepEqual(result.SOURCE_PREPARE,
    { completed: 1, total: 1, unit: "preparation steps" });
  assert.deepEqual(result.SOURCE_RUNNING,
    { completed: 4, total: 40, unit: "source searches started",
      currentCycle: 0, cyclesCreated: 0 });
});

test("source progress remains cumulative when a new continuation cycle starts", () => {
  const first = { startedCalls: 25 };
  const cycles = [
    { cycleIndex: 1, startedCalls: 7, status: "RUNNING" },
  ];
  const result = projectFullRunStageProgress({
    fullRun, discoveryRun: { startedTasks: 50 },
    sourceApproval: first, sourceCycles: cycles,
  });
  assert.equal(result.SOURCE_RUNNING.completed, 32);
  assert.equal(result.SOURCE_RUNNING.total, 40);
  assert.equal(result.SOURCE_RUNNING.currentCycle, 1);
  assert.equal(result.SOURCE_RUNNING.cyclesCreated, 1);
  cycles.push({ cycleIndex: 2, startedCalls: 0, status: "APPROVED" });
  const next = projectFullRunStageProgress({
    fullRun, discoveryRun: { startedTasks: 50 },
    sourceApproval: first, sourceCycles: cycles,
  });
  assert.equal(next.SOURCE_RUNNING.completed, 32);
  assert.equal(next.SOURCE_RUNNING.currentCycle, 2);
  assert.equal(next.SOURCE_RUNNING.cyclesCreated, 2);
});

test("missing/legacy stage data returns zero, zero-sized plans and capped usage safely", () => {
  const empty = projectFullRunStageProgress({ fullRun,
    discoveryRun: null, emailCounts: [], sourceApproval: null });
  assert.equal(empty.DISCOVERY.completed, 0);
  assert.equal(empty.EMAIL_TRIAGE.total, 0);
  assert.equal(empty.SOURCE_PREPARE.completed, 0);
  assert.equal(empty.SOURCE_RUNNING.completed, 0);
  assert.equal(empty.SOURCE_RUNNING.currentCycle, null);
  const over = projectFullRunStageProgress({
    fullRun, discoveryRun: { startedTasks: 51 },
    sourceApproval: { startedCalls: 50 },
  });
  assert.equal(over.DISCOVERY.completed, 50);
  assert.equal(over.SOURCE_RUNNING.completed, 40);
  assert.throws(() => projectFullRunStageProgress({
    fullRun: null,
  }), TypeError);
});

test("server endpoint keeps metrics owner scoped and read-only", async () => {
  const { readFileSync } = await import("node:fs");
  const api = readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
  const from = api.indexOf('app.get("/api/research-campaigns/:id/approved-run"');
  const to = api.indexOf('app.post("/api/research-campaigns/:id/execute-next"', from);
  assert.ok(from >= 0 && to > from);
  const endpoint = api.slice(from, to);
  assert.match(endpoint, /workspaceId: req.candidateScope/);
  assert.match(endpoint, /ownerId: identity.id/);
  assert.match(endpoint, /researchCampaignObservation.groupBy/);
  assert.match(endpoint, /researchPersonSourceCycle.findMany/);
  assert.match(endpoint, /stageProgress/);
  assert.doesNotMatch(endpoint, /runOneCampaignTask|reserveOwnerSpend|\.create\(/);
});
