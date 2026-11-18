import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateWorkspaceDailyLimit, validateResearchPreferences,
  RESEARCH_DAILY_WORKSPACE_LIMIT, RESEARCH_MAX_USER_DAILY_LIMIT }
  from "../server/research-quota.js";

const server = readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
const ui = readFileSync(new URL("../web/main.tsx", import.meta.url), "utf8");
const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
const migration = readFileSync(new URL("../prisma/migrations/20261119010000_ai98_workspace_daily_quota/migration.sql", import.meta.url), "utf8");

test("workspace and personal quota settings have bounded 1000 daily maximum", () => {
  assert.equal(RESEARCH_DAILY_WORKSPACE_LIMIT, 1000);
  assert.equal(RESEARCH_MAX_USER_DAILY_LIMIT, 1000);
  assert.equal(validateWorkspaceDailyLimit(1000), 1000);
  assert.equal(validateWorkspaceDailyLimit(1), 1);
  assert.equal(validateResearchPreferences({
    dailyLimit: 1000, maxCandidates: 20, maxConcurrent: 3,
  }).dailyLimit, 1000);
  for (const value of [-1, 0, 1001, Infinity, NaN, 1.5, "1000", null]) {
    assert.throws(() => validateWorkspaceDailyLimit(value), TypeError);
  }
});

test("additive schema migration preserves existing daily counters and has DB check", () => {
  assert.match(schema, /researchDailyLimit Int @default\(1000\)/);
  assert.match(migration, /ALTER TABLE "Partner"/);
  assert.match(migration, /DEFAULT 1000/);
  assert.match(migration, /CHECK \("researchDailyLimit" BETWEEN 1 AND 1000\)/);
  assert.doesNotMatch(migration, /(?:DELETE|UPDATE|TRUNCATE)\s+"ResearchDailyQuota"/);
});

test("workspace limit route is admin-only, origin gated, row locked and audited", () => {
  const route = server.slice(
    server.indexOf('app.put("/api/admin/partners/:id/research-limit"'),
    server.indexOf('app.get("/api/auth/google/start"'),
  );
  assert.match(route, /authenticated, requireOrigin/);
  assert.match(route, /safeParse\(req\.params\.id\)/);
  assert.match(route, /z\.number\(\)\.int\(\)\.min\(1\)\.max\(1000\)/);
  assert.match(route, /FOR UPDATE/);
  assert.match(route, /research\.workspace-daily-limit\.updated/);
  assert.match(route, /"no-store"/);
  assert.doesNotMatch(route, /requireWorkspaceMembership/);
});

test("workspace admin UI is separate from personal quota with budget invariants", () => {
  assert.match(ui, /Workspace daily research quotas/);
  assert.match(ui, /Save workspace quota/);
  assert.match(ui, /\/admin\/partners\/.*research-limit/);
  assert.match(ui, /Daily search attempts \(1–1000\)/);
  assert.match(ui, /Workspace daily quota is set by the administrator/);
  assert.match(ui, /Five concurrent workspace searches remain/);
  assert.match(server, /dailyLimit: z\.number\(\)\.int\(\)\.min\(1\)\.max\(RESEARCH_MAX_USER_DAILY_LIMIT\)/);
  assert.match(ui, /Personal limits, application budget and/);
});
