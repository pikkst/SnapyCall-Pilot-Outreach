import test from "node:test";
import assert from "node:assert/strict";
import {
  utcResearchDay, reserveResearchAttempt, ResearchQuotaExceeded,
  RESEARCH_DAILY_USER_WORKSPACE_LIMIT, RESEARCH_DAILY_WORKSPACE_LIMIT,
} from "../server/research-quota.js";

const workspaceId = "c" + "a".repeat(24);
const userId = "c" + "b".repeat(24);

test("daily quota boundary uses UTC, never local timezone", () => {
  assert.equal(utcResearchDay(new Date("2026-11-14T23:59:59.000Z")), "2026-11-14");
  assert.equal(utcResearchDay(new Date("2026-11-15T00:00:00.000Z")), "2026-11-15");
  assert.throws(() => utcResearchDay(new Date(NaN)));
});

test("conservative quota reserves both scopes and returns correct remaining budgets", async () => {
  const counts = new Map();
  const tx = { $queryRaw: async (_template, key, _day, limit) => {
    // Prisma receives tagged template interpolations as positional arguments.
    // Real SQL atomicity is covered by disposable PostgreSQL smoke.
    const current = counts.get(key) ?? 0;
    if (current >= limit) return [];
    counts.set(key, current + 1);
    return [{ attempts: current + 1 }];
  } };
  for (let i = 1; i <= RESEARCH_DAILY_USER_WORKSPACE_LIMIT; i++) {
    const result = await reserveResearchAttempt(tx, { workspaceId, userId,
      now: new Date("2026-11-14T12:00:00.000Z") });
    assert.equal(result.dayUtc, "2026-11-14");
    assert.equal(result.remaining.userWorkspace, RESEARCH_DAILY_USER_WORKSPACE_LIMIT - i);
    assert.equal(result.remaining.workspace, RESEARCH_DAILY_WORKSPACE_LIMIT - i);
  }
  await assert.rejects(() => reserveResearchAttempt(tx, { workspaceId, userId }),
    ResearchQuotaExceeded);
});

test("quota rejects client-controlled invalid identities without hitting database", async () => {
  let called = false;
  const tx = { $queryRaw: async () => { called = true; } };
  await assert.rejects(() => reserveResearchAttempt(tx, {
    workspaceId: "foreign", userId,
  }));
  assert.equal(called, false);
});


test("personal preferences respect server bounds and cannot be bypassed", async () => {
  const { validateResearchPreferences, RESEARCH_MAX_USER_DAILY_LIMIT } =
    await import("../server/research-quota.js");
  assert.deepEqual(validateResearchPreferences({ dailyLimit: 20, maxCandidates: 12 }),
    { dailyLimit: 20, maxCandidates: 12 });
  for (const input of [
    { dailyLimit: 0, maxCandidates: 10 },
    { dailyLimit: RESEARCH_MAX_USER_DAILY_LIMIT + 1, maxCandidates: 10 },
    { dailyLimit: 3.5, maxCandidates: 10 },
    { dailyLimit: 3, maxCandidates: 21 },
    { dailyLimit: 3, maxCandidates: "10" },
  ]) assert.throws(() => validateResearchPreferences(input));
});

test("custom daily threshold is enforced without changing the workspace ceiling", async () => {
  const counts = new Map();
  const tx = { $queryRaw: async (_sql, key, _day, ceiling) => {
    const current = counts.get(key) ?? 0;
    if (current >= ceiling) return [];
    counts.set(key, current + 1);
    return [{ attempts: current + 1 }];
  } };
  for (let i = 1; i <= 4; i++) {
    const data = await reserveResearchAttempt(tx, { workspaceId, userId, dailyLimit: 4 });
    assert.equal(data.remaining.userWorkspace, 4 - i);
    assert.equal(data.remaining.workspace, RESEARCH_DAILY_WORKSPACE_LIMIT - i);
  }
  await assert.rejects(() => reserveResearchAttempt(tx, {
    workspaceId, userId, dailyLimit: 4,
  }), ResearchQuotaExceeded);
  // Lowering a limit below already-consumed attempts never restores capacity.
  await assert.rejects(() => reserveResearchAttempt(tx, {
    workspaceId, userId, dailyLimit: 1,
  }), ResearchQuotaExceeded);
});
