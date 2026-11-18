import test from "node:test";
import assert from "node:assert/strict";
import { readResearchDailyCapacity } from "../server/research-quota.js";

const workspaceId = "c" + "a".repeat(24);
const userId = "c" + "b".repeat(24);
const now = new Date("2026-11-18T23:58:00.000Z");

function mock({ personalLimit = 100, workspaceLimit = 1000, workspaceUsed = 0, personalUsed = 0 } = {}) {
  const workspaceKey = "workspace:" + workspaceId;
  const userKey = "workspace-user:" + workspaceId + ":" + userId;
  const seen = [];
  const db = {
    partner: {
      findUnique: async ({ where }) => {
        assert.equal(where.id, workspaceId);
        return { researchDailyLimit: workspaceLimit };
      },
    },
    researchUserLimits: {
      findUnique: async ({ where, select }) => {
        assert.equal(where.ownerId, userId);
        assert.equal(select.dailyLimit, true);
        return personalLimit === null ? null : { dailyLimit: personalLimit };
      },
    },
    researchDailyQuota: {
      findMany: async ({ where, select }) => {
        seen.push(where);
        assert.equal(select.scopeKey, true);
        assert.equal(select.attempts, true);
        assert.deepEqual(where.scopeKey.in, [workspaceKey, userKey]);
        return [
          { scopeKey: workspaceKey, attempts: workspaceUsed },
          { scopeKey: userKey, attempts: personalUsed },
        ];
      },
    },
  };
  return { db, seen };
}

test("quota is owner/workspace scoped and computes minimum of both daily limits", async () => {
  const { db, seen } = mock({ personalLimit: 60, workspaceUsed: 25, personalUsed: 40 });
  const result = await readResearchDailyCapacity(db, { workspaceId, userId, now });
  assert.deepEqual(result, {
    dayUtc: "2026-11-18",
    resetsAt: "2026-11-19T00:00:00.000Z",
    workspaceLimit: 1000, workspaceUsed: 25,
    personalLimit: 60, personalUsed: 40, remaining: 20,
  });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].dayUtc, new Date("2026-11-18T00:00:00Z"));
});

test("workspace hard cap cannot be increased by changing personal limit", async () => {
  const { db } = mock({ personalLimit: 1000, workspaceLimit: 120, workspaceUsed: 120, personalUsed: 16 });
  const result = await readResearchDailyCapacity(db, { workspaceId, userId, now });
  assert.equal(result.remaining, 0);
  assert.equal(result.workspaceLimit, 120);
});

test("no saved personal limit defaults to two, and UTC reset rolls to next day", async () => {
  const { db } = mock({ personalLimit: null });
  const before = await readResearchDailyCapacity(db, { workspaceId, userId, now });
  assert.equal(before.personalLimit, 2);
  const after = await readResearchDailyCapacity(db, {
    workspaceId, userId, now: new Date("2026-11-19T00:00:00.000Z"),
  });
  assert.equal(after.dayUtc, "2026-11-19");
  assert.equal(after.resetsAt, "2026-11-20T00:00:00.000Z");
});

test("invalid quota counters fail closed", async () => {
  const { db } = mock({ personalLimit: 100, workspaceUsed: -1 });
  await assert.rejects(() => readResearchDailyCapacity(db, { workspaceId, userId, now }),
    TypeError);
  await assert.rejects(() => readResearchDailyCapacity(db, {
    workspaceId: "not-a-workspace", userId, now,
  }), TypeError);
});

test("quota preflight has no writes, provider calls or reservations", async () => {
  const { db } = mock();
  const value = await readResearchDailyCapacity(db, { workspaceId, userId, now });
  assert.equal(value.remaining, 100);
});

test("administrator can assign a 1000-per-day workspace ceiling", async () => {
  const { db } = mock({ personalLimit: 1000, workspaceLimit: 1000,
    workspaceUsed: 100, personalUsed: 100 });
  const capacity = await readResearchDailyCapacity(db, { workspaceId, userId, now });
  assert.equal(capacity.workspaceLimit, 1000);
  assert.equal(capacity.remaining, 900);
});

test("invalid persisted workspace quota fails closed", async () => {
  for (const workspaceLimit of [0, 1001, -10, NaN]) {
    const { db } = mock({ workspaceLimit });
    await assert.rejects(() => readResearchDailyCapacity(db, {
      workspaceId, userId, now,
    }), TypeError);
  }
});
