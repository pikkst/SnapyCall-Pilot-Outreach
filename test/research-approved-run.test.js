import test from "node:test";
import assert from "node:assert/strict";
import { approveCampaignRun, reserveApprovedRunCall, finishApprovedRunTask,
  validateCampaignRunApproval, stopApprovedCampaignRun, ApprovedRunBlocked }
  from "../server/research-campaign-run-approval.js";
import { tickApprovedCampaignRun } from "../server/research-approved-runner.js";

const campaignId = "cmabcdefghijklmnopqrstu";
const workspaceId = "cmabcdefghijklmnopqrstv";
const ownerId = "cmabcdefghijklmnopqrstw";
const limits = { maxTasks: 3, maxWorstCaseCents: 600,
  confirmConservativeBudget: true, confirmNoAutomaticRetry: true };
const price = { worstCaseCents: 200,
  priceVersion: "gemini-2.5-flash-grounded-prompt-2026-11-16" };
const fakeRun = {
  id: "cmrunabcdefghijklmnopqrs", campaignId, workspaceId, ownerId,
  provider: "gemini", model: "gemini-2.5-flash",
  priceVersion: price.priceVersion,
  worstCasePerCallCents: 200, maxTasks: 3, maxWorstCaseCents: 600,
  committedWorstCaseCents: 0, startedTasks: 0, status: "APPROVED",
  expiresAt: new Date("2099-01-01T00:00:00Z"),
};

test("approval requires explicit conservative total and no-repeat acceptance", () => {
  assert.deepEqual(validateCampaignRunApproval(limits),
    { maxTasks: 3, maxWorstCaseCents: 600 });
  for (const input of [
    { ...limits, confirmNoAutomaticRetry: false },
    { ...limits, confirmConservativeBudget: false },
    { ...limits, maxTasks: 25 },
    { ...limits, maxWorstCaseCents: 0 },
    { ...limits, provider: "gemini" },
  ]) assert.throws(() => validateCampaignRunApproval(input), TypeError);
});

test("new approval captures owner-owned frozen price envelope with no provider call", async () => {
  const actions = [];
  const tx = {
    $queryRaw: async parts => {
      const query = parts.join(" ");
      if (query.includes("PartnerMembership")) return [{ revokedAt: null }];
      if (query.includes("ResearchCampaign")) return [{
        id: campaignId, status: "QUEUED",
      }];
      throw new Error("Unexpected SQL");
    },
    researchCampaignRun: {
      findUnique: async () => null,
      create: async ({ data }) => {
        actions.push("approval");
        assert.equal(data.maxTasks, 3);
        assert.equal(data.maxWorstCaseCents, 600);
        assert.equal(data.priceVersion, price.priceVersion);
        assert.ok(data.expiresAt instanceof Date);
        assert.ok(data.expiresAt > new Date());
        return { ...fakeRun, ...data };
      },
    },
    researchCampaignTask: { count: async () => 0 },
    researchCampaignObservation: { count: async () => 0 },
    auditEvent: { create: async ({ data }) => {
      actions.push("audit");
      assert.equal(data.action, "research.campaign.run.approved");
      assert.equal(data.metadata.automaticBillableReplay, false);
    } },
  };
  const db = {
    aiSetting: { findUnique: async () =>
      ({ provider: fakeRun.provider, model: fakeRun.model }) },
    $transaction: fn => fn(tx),
  };
  const result = await approveCampaignRun(db, {
    campaignId, workspaceId, ownerId, input: limits,
  });
  assert.equal(result.status, 201);
  assert.equal(result.run.committedWorstCaseCents, 0);
  assert.deepEqual(actions, ["approval", "audit"]);
});

test("previously spent, already observed campaigns cannot gain autonomous approval", async () => {
  const db = {
    aiSetting: { findUnique: async () =>
      ({ provider: fakeRun.provider, model: fakeRun.model }) },
    $transaction: async fn => fn({
      $queryRaw: async p => p.join(" ").includes("PartnerMembership")
        ? [{ revokedAt: null }] : [{ id: campaignId, status: "RUNNING" }],
      researchCampaignRun: { findUnique: async () => null },
      researchCampaignTask: { count: async () => 1 },
      researchCampaignObservation: { count: async () => 101 },
    }),
  };
  const result = await approveCampaignRun(db, {
    campaignId, workspaceId, ownerId, input: limits,
  });
  assert.equal(result.code, "CAMPAIGN_ALREADY_STARTED");
});

test("run call consumes a worst-case reservation under campaign lock", async () => {
  const actions = [];
  const tx = {
    researchCampaignRun: {
      findUnique: async () => fakeRun,
      updateMany: async ({ where, data }) => {
        actions.push(data);
        assert.equal(where.committedWorstCaseCents.lte, 400);
        return { count: 1 };
      },
    },
    researchCampaignTask: { count: async () => 0 },
  };
  await reserveApprovedRunCall(tx, {
    campaignId, workspaceId, ownerId,
    provider: fakeRun.provider, model: fakeRun.model, price,
  });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].startedTasks.increment, 1);
  assert.equal(actions[0].committedWorstCaseCents.increment, 200);
});

test("max calls, conservative cents, provider drift and in-flight task fail closed", async () => {
  for (const [run, active, expected] of [
    [{ ...fakeRun, startedTasks: 3 }, 0, "RUN_LIMIT_REACHED"],
    [{ ...fakeRun, committedWorstCaseCents: 600 }, 0, "RUN_LIMIT_REACHED"],
    [{ ...fakeRun, model: "new-model" }, 0, "RUN_PRICE_OR_MODEL_CHANGED"],
    [fakeRun, 1, "RUN_TASK_ALREADY_IN_FLIGHT"],
    [{ ...fakeRun, status: "PAUSED" }, 0, "RUN_NOT_APPROVED"],
    [{ ...fakeRun, expiresAt: new Date("2020-01-01") }, 0, "RUN_APPROVAL_EXPIRED"],
  ]) {
    const tx = {
      researchCampaignRun: {
        findUnique: async () => run,
        updateMany: async () => { throw new Error("Should not reserve"); },
      },
      researchCampaignTask: { count: async () => active },
    };
    await assert.rejects(() => reserveApprovedRunCall(tx, {
      campaignId, workspaceId, ownerId, provider: fakeRun.provider,
      model: fakeRun.model, price,
    }), error => error instanceof ApprovedRunBlocked &&
      error.code === expected);
  }
});

test("controller runs one billable task per tick; ambiguous result pauses permanently", async () => {
  const events = [];
  const db = {
    researchCampaignRun: { findFirst: async () => ({
      campaignId, workspaceId, ownerId,
    }) },
  };
  const output = await tickApprovedCampaignRun(db, {
    encryptionKey: "test-only-encryption-secret",
    runTask: async (_db, args) => {
      events.push("task");
      assert.equal(args.autonomousApproved, true);
      return { status: "PAUSED", attempted: true,
        code: "BILLING_UNCERTAIN" };
    },
    finish: async (_db, result) => {
      events.push("finish");
      assert.equal(result.result.code, "BILLING_UNCERTAIN");
    },
    pause: async () => { throw new Error("Unexpected pause"); },
  });
  assert.equal(output.status, "PAUSED");
  assert.deepEqual(events, ["task", "finish"]);
});

test("worker must never replay when transport fails or another worker holds lease", async () => {
  const db = {
    researchCampaignRun: { findFirst: async () => ({
      campaignId, workspaceId, ownerId,
    }) },
  };
  const actions = [];
  const thrown = await tickApprovedCampaignRun(db, {
    encryptionKey: "test-only-encryption-secret",
    runTask: async () => {
      throw new Error("Provider may have billed");
    },
    finish: async () => { throw new Error("Unexpected finish"); },
    pause: async (_db, input) => actions.push(input.code),
  });
  assert.equal(thrown.status, "PAUSED");
  assert.deepEqual(actions, ["RUN_EXECUTION_UNCERTAIN"]);
  actions.length = 0;
  const inFlight = await tickApprovedCampaignRun(db, {
    encryptionKey: "test-only-encryption-secret",
    runTask: async () => {
      throw new ApprovedRunBlocked("RUN_TASK_ALREADY_IN_FLIGHT");
    },
    finish: async () => { throw new Error("Unexpected finish"); },
    pause: async () => { throw new Error("Must not pause active owner worker"); },
  });
  assert.equal(inFlight.status, "IN_FLIGHT");
});

test("completed campaign finalizes approval, no provider work on idle", async () => {
  const writes = [];
  const db = {
    $transaction: fn => fn({
      $queryRaw: async p => p.join(" ").includes("PartnerMembership")
        ? [{ revokedAt: null }]
        : [{ id: campaignId, status: "COMPLETED" }],
      researchCampaignRun: {
        findUnique: async () => ({
          ...fakeRun, status: "RUNNING", startedTasks: 1,
          committedWorstCaseCents: 200,
        }),
        update: async ({ data }) => writes.push(data),
      },
    }),
  };
  const finished = await finishApprovedRunTask(db, {
    campaignId, workspaceId, ownerId,
    result: { status: "NO_READY_TASK" },
  });
  assert.equal(finished.code, "COMPLETED");
  assert.equal(writes[0].status, "COMPLETED");
  const idle = await tickApprovedCampaignRun({
    researchCampaignRun: { findFirst: async () => null },
  }, { encryptionKey: "test-only-encryption-secret",
    runTask: async () => { throw new Error("Should not start"); } });
  assert.equal(idle.status, "IDLE");
});

test("owner stop is idempotent, survives restarts, never touches in-flight spend", async () => {
  const events = [];
  const existing = { ...fakeRun, status: "RUNNING", startedTasks: 2,
    committedWorstCaseCents: 400 };
  const db = { $transaction: async fn => fn({
    $queryRaw: async parts => parts.join(" ").includes("PartnerMembership")
      ? [{ revokedAt: null }] : [{ id: campaignId }],
    researchCampaignRun: {
      findUnique: async () => existing,
      update: async ({ data }) => {
        events.push("status-" + data.status);
        assert.equal(data.lastCode, "USER_STOPPED");
        return { ...existing, ...data };
      },
    },
    auditEvent: { create: async ({ data }) => {
      events.push(data.action);
      assert.equal(data.metadata.inFlightMayStillBeBilled, true);
      assert.equal(data.metadata.automaticRetryAllowed, false);
    } },
  }) };
  const result = await stopApprovedCampaignRun(db, {
    campaignId, workspaceId, ownerId,
  });
  assert.equal(result.code, "RUN_STOPPED");
  assert.equal(result.run.status, "PAUSED");
  assert.equal(result.run.committedWorstCaseCents, 400);
  assert.deepEqual(events, [
    "status-PAUSED", "research.campaign.run.stopped",
  ]);
});

test("stopped or foreign run cannot be mutated", async () => {
  let updated = false;
  const db = { $transaction: async fn => fn({
    $queryRaw: async parts => parts.join(" ").includes("PartnerMembership")
      ? [{ revokedAt: null }] : [{ id: campaignId }],
    researchCampaignRun: {
      findUnique: async () => ({ ...fakeRun, status: "PAUSED" }),
      update: async () => { updated = true; },
    },
  }) };
  const existing = await stopApprovedCampaignRun(db, {
    campaignId, workspaceId, ownerId,
  });
  assert.equal(existing.code, "RUN_ALREADY_TERMINAL");
  assert.equal(updated, false);
});


test("successful tenth bounded task finalizes partial campaign without new paid calls", async () => {
  const events = [];
  const db = { $transaction: async fn => fn({
    $queryRaw: async p => p.join(" ").includes("PartnerMembership")
      ? [{ revokedAt: null }]
      : [{ id: campaignId, status: "RUNNING" }],
    researchCampaignRun: {
      findUnique: async () => ({
        ...fakeRun, status: "RUNNING", startedTasks: 3,
        committedWorstCaseCents: 600,
      }),
      update: async ({ data }) => {
        events.push(["run", data.status, data.lastCode]);
        return data;
      },
    },
    researchCampaignTask: {
      count: async ({ where }) => {
        assert.equal(where.campaignId, campaignId);
        assert.equal(where.status, "RUNNING");
        events.push("checked-inflight");
        return 0;
      },
    },
    researchCampaign: {
      updateMany: async ({ where, data }) => {
        assert.deepEqual(where, {
          id: campaignId, workspaceId, ownerId, status: "RUNNING",
        });
        assert.equal(data.status, "PARTIAL");
        events.push("campaign-PARTIAL");
        return { count: 1 };
      },
    },
    auditEvent: {
      create: async ({ data }) => {
        assert.equal(data.action, "research.campaign.finalized");
        assert.equal(data.entityId, campaignId);
        assert.equal(data.metadata.status, "PARTIAL");
        assert.equal(data.metadata.reason, "IMMUTABLE_APPROVED_RUN_LIMIT_REACHED");
        assert.equal(data.metadata.automaticBillableReplay, false);
        events.push("audit-PARTIAL");
      },
    },
  }) };
  const out = await finishApprovedRunTask(db, {
    campaignId, workspaceId, ownerId, result: { status: "COMPLETED" },
  });
  assert.equal(out.code, "COMPLETED");
  assert.equal(out.lastCode, "RUN_LIMIT_REACHED");
  assert.deepEqual(events, ["checked-inflight", "campaign-PARTIAL",
    "audit-PARTIAL", ["run", "COMPLETED", "RUN_LIMIT_REACHED"]]);
});

test("run cap never finalizes campaign while a task remains in flight", async () => {
  let campaignUpdated = false;
  const writes = [];
  const db = { $transaction: async fn => fn({
    $queryRaw: async p => p.join(" ").includes("PartnerMembership")
      ? [{ revokedAt: null }]
      : [{ id: campaignId, status: "RUNNING" }],
    researchCampaignRun: {
      findUnique: async () => ({
        ...fakeRun, status: "RUNNING", startedTasks: 3,
        committedWorstCaseCents: 600,
      }),
      update: async ({ data }) => { writes.push(data); return data; },
    },
    researchCampaignTask: { count: async () => 1 },
    researchCampaign: {
      updateMany: async () => { campaignUpdated = true; },
    },
  }) };
  const out = await finishApprovedRunTask(db, {
    campaignId, workspaceId, ownerId, result: { status: "COMPLETED" },
  });
  assert.equal(out.code, "PAUSED");
  assert.equal(out.lastCode, "RUN_LIMIT_REACHED");
  assert.equal(campaignUpdated, false);
  assert.equal(writes[0].status, "PAUSED");
});

test("uncertain provider result cannot finalize partial campaign at run limit", async () => {
  let attempted = false;
  const writes = [];
  const db = { $transaction: async fn => fn({
    $queryRaw: async p => p.join(" ").includes("PartnerMembership")
      ? [{ revokedAt: null }]
      : [{ id: campaignId, status: "RUNNING" }],
    researchCampaignRun: {
      findUnique: async () => ({
        ...fakeRun, status: "RUNNING", startedTasks: 3,
        committedWorstCaseCents: 600,
      }),
      update: async ({ data }) => { writes.push(data); return data; },
    },
    researchCampaignTask: { count: async () => { attempted = true; return 0; } },
    researchCampaign: { updateMany: async () => { attempted = true; } },
  }) };
  const out = await finishApprovedRunTask(db, {
    campaignId, workspaceId, ownerId,
    result: { status: "PAUSED", code: "BILLING_UNCERTAIN" },
  });
  assert.equal(out.code, "PAUSED");
  assert.equal(out.lastCode, "BILLING_UNCERTAIN");
  assert.equal(attempted, false);
  assert.equal(writes[0].status, "PAUSED");
});
