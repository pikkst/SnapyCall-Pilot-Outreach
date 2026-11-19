import test from "node:test";
import assert from "node:assert/strict";
import { projectFullRunTiming } from "../server/research-run-timing.js";

const at = text => new Date(text);
const start = "2026-11-18T23:02:02.077Z";
const full = (status = "SOURCE_RUNNING", updatedAt = "2026-11-19T00:19:38.794Z") =>
  ({ status, approvedAt: at(start), updatedAt: at(updatedAt) });
const change = (time, priorStage, stage) => ({
  createdAt: at(time), metadata: { priorStage, stage },
});
const audit = [
  change("2026-11-19T00:08:19.326Z", "DISCOVERY", "EMAIL_TRIAGE"),
  change("2026-11-19T00:19:30.490Z", "EMAIL_TRIAGE", "SOURCE_PREPARE"),
  change("2026-11-19T00:19:38.794Z", "SOURCE_PREPARE", "SOURCE_RUNNING"),
];
const now = at("2026-11-19T00:35:00.000Z");

test("stages use persisted approval and exact transition times", () => {
  const result = projectFullRunTiming(full(), [...audit].reverse(), { now });
  assert.equal(result.startedAt, start);
  assert.equal(result.currentStage, "SOURCE_RUNNING");
  assert.equal(result.finishedAt, null);
  assert.deepEqual(result.stages.map(x => x.key),
    ["DISCOVERY", "EMAIL_TRIAGE", "SOURCE_PREPARE", "SOURCE_RUNNING"]);
  assert.equal(result.stages[0].finishedAt, "2026-11-19T00:08:19.326Z");
  assert.equal(result.stages[1].startedAt, result.stages[0].finishedAt);
  assert.equal(result.stages[1].finishedAt, "2026-11-19T00:19:30.490Z");
  assert.equal(result.stages[2].finishedAt, "2026-11-19T00:19:38.794Z");
  assert.equal(result.stages[3].finishedAt, null);
});

test("stopped run freezes all durations at persisted DB timestamp", () => {
  const stoppedAt = "2026-11-19T00:41:08.968Z";
  const result = projectFullRunTiming(full("STOPPED", stoppedAt), audit,
    { now: at("2026-11-20T02:00:00.000Z") });
  assert.equal(result.finishedAt, stoppedAt);
  assert.equal(result.stages[3].finishedAt, stoppedAt);
  assert.equal(result.currentStage, null);
  assert.equal(result.stages[0].finishedAt, audit[0].createdAt.toISOString());
});

test("future stages are not assigned invented durations or start times", () => {
  const result = projectFullRunTiming(full("DISCOVERY", start), [], { now });
  assert.equal(result.currentStage, "DISCOVERY");
  assert.equal(result.stages[0].startedAt, start);
  assert.equal(result.stages[0].finishedAt, null);
  assert.ok(result.stages.slice(1).every(x =>
    x.startedAt === null && x.finishedAt === null));
});

test("missing or duplicated audit events cannot fabricate skipped stage timing", () => {
  const bad = [
    change("2026-11-19T00:08:19.326Z", "DISCOVERY", "SOURCE_RUNNING"),
    change("2026-11-19T00:08:19.326Z", "EMAIL_TRIAGE", "SOURCE_RUNNING"),
    change("2026-11-19T00:00:00.000Z", "SOURCE_RUNNING", "SOURCE_PREPARE"),
  ];
  const result = projectFullRunTiming(full("SOURCE_RUNNING"), bad, { now });
  assert.equal(result.stages[1].startedAt, null);
  assert.equal(result.stages[3].startedAt, null);
  assert.equal(result.currentStage, null);
});

test("stage terminal audit and race-safe timestamp validation", () => {
  const terminal = projectFullRunTiming(full("PARTIAL", "2026-11-19T00:20:00.000Z"),
    [...audit, change("2026-11-19T00:20:00.000Z", "SOURCE_RUNNING", "PARTIAL")],
    { now });
  assert.equal(terminal.stages[3].finishedAt, "2026-11-19T00:20:00.000Z");
  assert.equal(terminal.currentStage, null);
  assert.throws(() => projectFullRunTiming(full(), Array(41).fill(audit[0])), TypeError);
  assert.throws(() => projectFullRunTiming({ status: "DISCOVERY",
    approvedAt: "not a date" }, []), TypeError);
});
