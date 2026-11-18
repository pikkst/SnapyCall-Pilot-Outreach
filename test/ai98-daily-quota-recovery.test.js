import test from "node:test";
import assert from "node:assert/strict";
import { ResearchQuotaExceeded, utcResearchDay } from "../server/research-quota.js";
import { tickApprovedCampaignRun } from "../server/research-approved-runner.js";
import { finishApprovedRunTask } from "../server/research-campaign-run-approval.js";

const campaignId = "c" + "a".repeat(24);
const workspaceId = "c" + "b".repeat(24);
const ownerId = "c" + "c".repeat(24);
const scope = { campaignId, workspaceId, ownerId };
const encryptionKey = "test-only-encryption-key-not-a-real-secret";

function runFixture({ expiresAt = new Date("2099-01-01"), unresolved = 0,
  startedTasks = 16, maxTasks = 50, committedWorstCaseCents = 48,
  maxWorstCaseCents = 150, status = "RUNNING", member = true } = {}) {
  const writes = [];
  const run = { id: "run-1", ...scope, status, expiresAt,
    startedTasks, maxTasks, committedWorstCaseCents,
    maxWorstCaseCents, worstCasePerCallCents: 3 };
  const tx = {
    $queryRaw: async chunks => {
      const sql = chunks.join("?");
      if (sql.includes('FROM "PartnerMembership"'))
        return member ? [{ revokedAt: null }] : [];
      if (sql.includes('FROM "ResearchCampaign"'))
        return [{ id: campaignId, status: "RUNNING" }];
      throw new Error("Unexpected SQL: " + sql);
    },
    researchCampaignRun: {
      findUnique: async () => run,
      update: async ({ data }) => { writes.push(data); return { ...run, ...data }; },
    },
    researchCampaignTask: {
      count: async () => unresolved,
    },
  };
  return { db: { $transaction: async fn => fn(tx) }, writes };
}

async function finishQuota(fixture) {
  return finishApprovedRunTask(fixture.db, {
    ...scope, result: { status: "DAILY_QUOTA_WAIT", attempted: false },
  });
}

test("daily quota exhaustion is a nonbillable wait and never calls pause", async () => {
  let pauseCalls = 0;
  const finishes = [];
  const db = { researchCampaignRun: { findFirst: async () => scope } };
  const result = await tickApprovedCampaignRun(db, {
    encryptionKey,
    runTask: async () => { throw new ResearchQuotaExceeded(); },
    finish: async (_, input) => {
      finishes.push(input);
      return { code: "RUNNING", lastCode: "WAITING_DAILY_QUOTA" };
    },
    pause: async () => { pauseCalls++; },
  });
  assert.equal(result.status, "WAITING");
  assert.equal(result.code, "WAITING_DAILY_QUOTA");
  assert.equal(pauseCalls, 0);
  assert.equal(finishes.length, 1);
  assert.deepEqual(finishes[0].result, {
    status: "DAILY_QUOTA_WAIT", attempted: false,
  });
});

test("quota wait persists under campaign and membership locks without changing allowance", async () => {
  const f = runFixture();
  const value = await finishQuota(f);
  assert.deepEqual(value, { code: "RUNNING", lastCode: "WAITING_DAILY_QUOTA" });
  assert.deepEqual(f.writes, [{ status: "RUNNING", lastCode: "WAITING_DAILY_QUOTA" }]);
});

test("quota wait cannot resurrect expired or exhausted approval", async () => {
  for (const config of [
    { expiresAt: new Date("2020-01-01") },
    { startedTasks: 50 },
    { committedWorstCaseCents: 150 },
  ]) {
    const f = runFixture(config);
    const value = await finishQuota(f);
    assert.equal(value.code, "PAUSED");
    assert.equal(f.writes[0].status, "PAUSED");
    if (config.expiresAt) assert.equal(value.lastCode, "RUN_APPROVAL_EXPIRED");
  }
});

test("quota wait fails closed on previously uncertain tasks", async () => {
  const f = runFixture({ unresolved: 1 });
  const value = await finishQuota(f);
  assert.deepEqual(value, { code: "PAUSED", lastCode: "RUN_EXECUTION_UNCERTAIN" });
});

test("revoked membership and already paused runs are never resumed", async () => {
  const revoked = runFixture({ member: false });
  assert.deepEqual(await finishQuota(revoked),
    { code: "WORKSPACE_ACCESS_REVOKED" });
  assert.equal(revoked.writes.length, 0);
  const paused = runFixture({ status: "PAUSED" });
  assert.deepEqual(await finishQuota(paused), { code: "RUN_NOT_ACTIVE" });
  assert.equal(paused.writes.length, 0);
});

test("UTC day rollover permits only an already approved and bounded continuation", async () => {
  assert.equal(utcResearchDay(new Date("2026-11-18T23:59:59.999Z")),
    "2026-11-18");
  assert.equal(utcResearchDay(new Date("2026-11-19T00:00:00Z")),
    "2026-11-19");
  const f = runFixture();
  let calls = 0;
  const db = {
    researchCampaignRun: { findFirst: async () => scope },
  };
  const result = await tickApprovedCampaignRun(db, {
    encryptionKey,
    runTask: async () => {
      calls++;
      if (calls === 1) throw new ResearchQuotaExceeded();
      return { status: "COMPLETED" };
    },
    finish: async (_, input) => finishApprovedRunTask(f.db, input),
    pause: async () => { throw Error("No uncertain run to pause"); },
  });
  assert.equal(result.status, "WAITING");
  assert.equal(f.writes.length, 1);
  const next = await tickApprovedCampaignRun(db, {
    encryptionKey,
    runTask: async () => {
      calls++;
      return { status: "COMPLETED" };
    },
    finish: async (_, input) => finishApprovedRunTask(f.db, input),
    pause: async () => { throw Error("Unexpected pause"); },
  });
  assert.equal(next.status, "COMPLETED");
  assert.equal(calls, 2);
});
