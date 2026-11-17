import test from "node:test";
import assert from "node:assert/strict";
import { finishApprovedRunTask } from "../server/research-campaign-run-approval.js";

const campaignId = "cmabcdefghijklmnopqrstu";
const workspaceId = "cmabcdefghijklmnopqrstv";
const ownerId = "cmabcdefghijklmnopqrstw";
const scope = { campaignId, workspaceId, ownerId };

function mockDb({
  campaignStatus = "RUNNING", runStatus = "RUNNING",
  expiresAt = new Date("2099-01-01T00:00:00Z"),
  startedTasks = 1, maxTasks = 24,
  committedWorstCaseCents = 200, maxWorstCaseCents = 4800,
  unresolved = 0, futureQueued = true, member = true,
} = {}) {
  const writes = [];
  const run = {
    id: "cmabcdefghijklmnopqrstx", ...scope, status: runStatus,
    expiresAt, startedTasks, maxTasks, committedWorstCaseCents,
    maxWorstCaseCents, worstCasePerCallCents: 200,
  };
  const tx = {
    $queryRaw: async parts => {
      const sql = parts.join(" ");
      if (sql.includes('FROM "PartnerMembership"')) {
        return member ? [{ revokedAt: null }] : [];
      }
      if (sql.includes('FROM "ResearchCampaign"')) {
        return [{ id: campaignId, status: campaignStatus }];
      }
      throw Error("Unexpected SQL");
    },
    researchCampaignRun: {
      findUnique: async () => run,
      update: async args => { writes.push(args.data); return args.data; },
    },
    researchCampaignTask: {
      count: async () => unresolved,
      findFirst: async () => futureQueued ? { id: "waiting-task" } : null,
    },
  };
  return { db: { $transaction: fn => fn(tx) }, writes };
}

test("NO_READY_TASK during bounded retry window stays RUNNING without a new approval", async () => {
  const { db, writes } = mockDb();
  const result = await finishApprovedRunTask(db, {
    ...scope, result: { status: "NO_READY_TASK", attempted: false },
  });
  assert.deepEqual(result, { code: "RUNNING", lastCode: "WAITING_RETRY" });
  assert.deepEqual(writes, [{ status: "RUNNING", lastCode: "WAITING_RETRY" }]);
});

test("paused, failed or running tasks are never mistaken for harmless retry waits", async () => {
  for (const unresolved of [1, 2]) {
    const { db, writes } = mockDb({ unresolved });
    const result = await finishApprovedRunTask(db, {
      ...scope, result: { status: "NO_READY_TASK", attempted: false },
    });
    assert.equal(result.code, "PAUSED");
    assert.equal(writes[0].status, "PAUSED");
  }
});

test("no future retry, exhausted approval and expired approval pause safely", async () => {
  for (const options of [
    { futureQueued: false }, { maxTasks: 1 },
    { maxWorstCaseCents: 200 }, { expiresAt: new Date("2000-01-01") },
  ]) {
    const { db } = mockDb(options);
    const result = await finishApprovedRunTask(db, {
      ...scope, result: { status: "NO_READY_TASK" },
    });
    assert.equal(result.code, "PAUSED");
  }
});

test("terminal campaign can finish without triggering another paid task", async () => {
  const { db, writes } = mockDb({ campaignStatus: "PARTIAL" });
  const result = await finishApprovedRunTask(db, {
    ...scope, result: { status: "NO_READY_TASK" },
  });
  assert.deepEqual(result, { code: "COMPLETED", lastCode: "CAMPAIGN_FINISHED" });
  assert.equal(writes[0].status, "COMPLETED");
});

test("revoked workspace membership forbids approved run state mutations", async () => {
  const { db, writes } = mockDb({ member: false });
  const result = await finishApprovedRunTask(db, {
    ...scope, result: { status: "NO_READY_TASK" },
  });
  assert.deepEqual(result, { code: "WORKSPACE_ACCESS_REVOKED" });
  assert.deepEqual(writes, []);
});
