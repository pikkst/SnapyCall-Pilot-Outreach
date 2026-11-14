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
