import test from "node:test";
import assert from "node:assert/strict";
import { tickPersonSourcePipeline, quarantineUnverifiablePersonSource,
  finalizePersonSourceStage } from "../server/research-person-source-runner.js";

const scope = {
  campaignId: "cmabcdefghijklmnopqrstu",
  workspaceId: "cmabcdefghijklmnopqrstv",
  ownerId: "cmabcdefghijklmnopqrstw",
};
const jobId = "cmabcdefghijklmnopqrs1";
const config = { encryptionKey: "test-encryption-key-32-characters" };

function mock({ approval = true, proposed = false } = {}) {
  const calls = [];
  const db = {
    researchPersonSourceApproval: {
      findFirst: async () => approval ? scope : null,
    },
    researchPersonSourceCycle: { findFirst: async () => null },
    researchPersonSourceJob: {
      findFirst: async () => proposed ? { id: jobId } : null,
    },
  };
  return { db, calls };
}

test("without a persisted explicit approval, worker does no provider or page calls", async () => {
  const x = mock({ approval: false });
  const result = await tickPersonSourcePipeline(x.db, {
    ...config,
    runTask: async () => { throw Error("Unexpected provider call"); },
    inspect: async () => { throw Error("Unexpected public page call"); },
  });
  assert.equal(result.status, "IDLE");
});

test("restart processes saved unverified proposal before any new paid research", async () => {
  const x = mock({ proposed: true });
  const actions = [];
  const result = await tickPersonSourcePipeline(x.db, {
    ...config,
    inspect: async (_, payload) => {
      actions.push("inspect");
      assert.equal(payload.jobId, jobId);
      return { status: 200,
        code: "NAMED_EMAIL_EVIDENCE_REVIEW_REQUIRED",
        qualifiedEvidence: true };
    },
    runTask: async () => { actions.push("paid"); throw Error("Not expected"); },
  });
  assert.equal(result.status, "QUALIFIED_EVIDENCE");
  assert.deepEqual(actions, ["inspect"]);
});

test("shared cited URL gets quarantined, not fetched or retried", async () => {
  const x = mock({ proposed: true });
  const actions = [];
  const result = await tickPersonSourcePipeline(x.db, {
    ...config,
    inspect: async () => {
      actions.push("inspect");
      return { status: 409, code: "SHARED_SOURCE_REQUIRES_REVIEW" };
    },
    quarantine: async (_, payload, code) => {
      actions.push("quarantine");
      assert.equal(payload.jobId, jobId);
      assert.equal(code, "SHARED_SOURCE_REQUIRES_REVIEW");
      return { status: "REVIEW_REQUIRED", code };
    },
    runTask: async () => { throw Error("No further paid task"); },
  });
  assert.equal(result.status, "REVIEW_REQUIRED");
  assert.deepEqual(actions, ["inspect", "quarantine"]);
});

test("one approved tick executes one bounded job, without implicit extra calls", async () => {
  const x = mock();
  let attempts = 0;
  const result = await tickPersonSourcePipeline(x.db, {
    ...config,
    runTask: async (_, payload) => {
      attempts++;
      assert.equal(payload.campaignId, scope.campaignId);
      return { status: "COMPLETED", sourceProposed: true };
    },
  });
  assert.equal(result.status, "COMPLETED");
  assert.equal(attempts, 1);
});

test("unsettled paid attempt never triggers a second task in the tick", async () => {
  const x = mock();
  let attempts = 0;
  const result = await tickPersonSourcePipeline(x.db, {
    ...config,
    runTask: async () => {
      attempts++;
      return { status: "PAUSED", code: "BILLING_UNCERTAIN" };
    },
  });
  assert.equal(result.status, "PAUSED");
  assert.equal(result.code, "BILLING_UNCERTAIN");
  assert.equal(attempts, 1);
});

test("successful terminal source-stage results finalize without claiming a job", async () => {
  const x = mock();
  const result = await tickPersonSourcePipeline(x.db, {
    ...config,
    runTask: async () => ({ status: "IDLE", code: "NO_SOURCE_JOB_READY" }),
    finalize: async () => ({ status: "COMPLETED",
      code: "SOURCE_STAGE_TERMINAL" }),
  });
  assert.equal(result.status, "COMPLETED");
});

test("persistent review block is owner-scoped and non-billable", async () => {
  const events = [];
  const db = {
    $transaction: async fn => fn({
      $queryRaw: async chunks => {
        const sql = chunks.join("?");
        if (sql.includes('FROM "PartnerMembership"'))
          return [{ revokedAt: null }];
        if (sql.includes('FROM "ResearchCampaign"')) return [{ id: scope.campaignId }];
        throw Error("Unexpected SQL");
      },
      researchPersonSourceApproval: {
        findUnique: async () => ({
          workspaceId: scope.workspaceId, ownerId: scope.ownerId,
          publicInspectionAuthorized: true, status: "RUNNING",
          expiresAt: new Date(Date.now() + 60000),
        }),
      },
      researchPersonSourceJob: {
        findFirst: async () => ({ cycleIndex: 0, status: "COMPLETED" }),
        updateMany: async ({ data }) => {
          events.push(data.status); return { count: 1 };
        },
      },
      auditEvent: { create: async ({ data }) => {
        events.push("audit");
        assert.equal(data.metadata.sendingEnabled, false);
      } },
    }),
  };
  const result = await quarantineUnverifiablePersonSource(db,
    { ...scope, jobId }, "SHARED_SOURCE_REQUIRES_REVIEW");
  assert.equal(result.status, "REVIEW_REQUIRED");
  assert.deepEqual(events, ["SOURCE_REVIEW_REQUIRED", "audit"]);
  await assert.rejects(() => quarantineUnverifiablePersonSource(
    db, { ...scope, jobId }, "BILLING_UNCERTAIN"), TypeError);
});

test("terminal stage preserves unspent but unavailable research work as PARTIAL", async () => {
  const events = [];
  const db = {
    $transaction: async fn => fn({
      $queryRaw: async chunks => {
        const sql = chunks.join("?");
        if (sql.includes('FROM "PartnerMembership"'))
          return [{ revokedAt: null }];
        if (sql.includes('FROM "ResearchCampaign"')) return [{ id: scope.campaignId }];
        throw Error("Unexpected SQL");
      },
      researchPersonSourceApproval: {
        findUnique: async () => ({
          id: "approval-id", workspaceId: scope.workspaceId, ownerId: scope.ownerId,
          status: "RUNNING", eligibleJobCount: 2, startedCalls: 1,
          maxCalls: 1, worstCasePerCallCents: 150,
          committedWorstCaseCents: 150, maxWorstCaseCents: 150,
        }),
        updateMany: async ({ data }) => {
          events.push(data.status); return { count: 1 };
        },
      },
      researchPersonSourceJob: {
        findMany: async () => [
          { status: "VERIFIED", proposedSourceUrl: "https://example.org/ada" },
          { status: "QUEUED", proposedSourceUrl: null },
        ],
      },
      auditEvent: { create: async () => { events.push("audit"); } },
    }),
  };
  const result = await finalizePersonSourceStage(db, scope);
  assert.equal(result.status, "PARTIAL_BUDGET");
  assert.deepEqual(events, ["PARTIAL_BUDGET", "audit"]);
});
