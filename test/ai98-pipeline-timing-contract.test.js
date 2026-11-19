import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const server = readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
const ui = readFileSync(new URL("../web/main.tsx", import.meta.url), "utf8");

test("existing owner-scoped status API returns read-only persisted timeline", () => {
  const start = server.indexOf('app.get("/api/research-campaigns/:id/approved-run"');
  const end = server.indexOf('app.post("/api/research-campaigns/:id/execute-next"', start);
  assert.ok(start > 0 && end > start);
  const route = server.slice(start, end);
  assert.match(route, /candidateReadScope/);
  assert.match(route, /ownerId: identity\.id/);
  assert.match(route, /actorId: identity\.id/);
  assert.match(route, /action: "research\.full-run\.stage\.changed"/);
  assert.match(route, /take: 41/);
  assert.match(route, /projectFullRunTiming/);
  assert.match(route, /serverNow: new Date\(\)\.toISOString\(\)/);
  assert.match(route, /"no-store"/);
  assert.doesNotMatch(route, /researchCandidates\(|reserveResearchAttempt\(/);
});

test("visible pipeline window uses a one-second UI clock and server event boundaries", () => {
  assert.match(ui, /aria-label="Research pipeline timers"/);
  assert.match(ui, /Total run duration/);
  assert.match(ui, /elapsedRunClock\(timeline\.startedAt, timeline\.finishedAt, nowMs\)/);
  assert.match(ui, /timeline\.stages\.map\(stage/);
  assert.match(ui, /stage\.startedAt/);
  assert.match(ui, /stage\.finishedAt/);
  assert.match(ui, /Not started/);
  assert.match(ui, /window\.setInterval\(\(\) => setRunTimerClock\(Date\.now\(\)\), 1000\)/);
  assert.match(ui, /window\.clearInterval\(id\)/);
  assert.match(ui, /receivedAt: Date\.now\(\)/);
  assert.match(ui, /no completion estimate is implied/);
});
