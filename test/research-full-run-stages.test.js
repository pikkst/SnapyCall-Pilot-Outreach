import test from "node:test";
import assert from "node:assert/strict";
import { tickFullRunStages, transitionFullRunStage }
  from "../server/research-full-run-stages.js";
import { requireResearchPriceEnvelope }
  from "../server/research-price-policy.js";

const price = requireResearchPriceEnvelope({
  provider: "gemini", model: "gemini-3-flash-preview",
});
const scope = {
  campaignId: "cmabcdefghijklmnopqrstu",
  workspaceId: "cmabcdefghijklmnopqrstv",
  ownerId: "cmabcdefghijklmnopqrstw",
};
const now = new Date("2026-11-18T15:35:00Z");
function fixture({ stage = "DISCOVERY", status = "PARTIAL",
  triageStatus = "IDLE", observations = 2, qualified = 0,
  jobs = 2, sourceStatus = null, expires = false,
  model = "gemini-3-flash-preview" } = {}) {
  const actions = [];
  const full = { id: "cmabcdefghijklmnopqrsfull",
    ...scope, status: stage, provider: "gemini", model,
    priceVersion: price.priceVersion,
    targetQualifiedContacts: 100,
    maxSourceCalls: 1, maxSourceWorstCaseCents: price.worstCaseCents,
    maxEmailInspectionPages: 250, publicInspectionAuthorized: true,
    expiresAt: new Date(now.getTime() + (expires ? -1000 : 600000)),
  };
  const db = {
    researchFullRun: { findFirst: async () => full },
    researchCampaign: { findFirst: async () => ({
      id: scope.campaignId, status, emailTriageStatus: triageStatus,
    }) },
    researchCampaignObservation: { count: async () => observations },
    researchPersonSourceApproval: { findUnique: async () => sourceStatus
      ? { ...scope, status: sourceStatus, provider: full.provider,
        model: full.model, priceVersion: full.priceVersion,
        publicInspectionAuthorized: true } : null },
    researchPersonSourceJob: { count: async () => jobs },
    aiSetting: { findUnique: async () => ({
      provider: "gemini", model: "gemini-3-flash-preview",
    }) },
  };
  const input = {
    now: () => now,
    progress: async () => ({
      reliable: true, qualifiedEvidence: qualified,
    }),
    transition: async (_, owner, args) => {
      assert.equal(owner.campaignId, scope.campaignId);
      assert.equal(args.from, stage);
      actions.push("stage:" + args.to);
      return { status: args.to, code: args.code };
    },
    approveTriage: async (_, args) => {
      actions.push("triage");
      assert.equal(args.confirmPublicInspection, true);
      assert.equal(args.confirmSkipUninspectable, true);
      assert.equal(args.maxPages, 250);
      return { code: "EMAIL_TRIAGE_APPROVED" };
    },
    enqueue: async (_, args) => {
      actions.push("queue");
      assert.equal(args.confirmQueuePreparation, true);
      return { status: 200, jobsAdded: jobs, jobsTotal: jobs };
    },
    approveSource: async (_, args) => {
      actions.push("source-approval");
      assert.equal(args.input.maxCalls, 1);
      assert.equal(args.input.maxWorstCaseCents, price.worstCaseCents);
      assert.equal(args.input.confirmPublicInspection, true);
      assert.equal(args.input.confirmNoAutomaticRetry, true);
      return { code: "SOURCE_RUN_APPROVED" };
    },
  };
  return { db, full, input, actions };
}

test("discovery still running never starts a second stage or reports 100 emails", async () => {
  const f = fixture({ status: "RUNNING" });
  const result = await tickFullRunStages(f.db, f.input);
  assert.equal(result.code, "DISCOVERY_RUNNING");
  assert.deepEqual(f.actions, []);
});

test("one up-front approval transitions to bounded public email inspection", async () => {
  const f = fixture();
  const result = await tickFullRunStages(f.db, f.input);
  assert.equal(result.status, "EMAIL_TRIAGE");
  assert.deepEqual(f.actions, ["triage", "stage:EMAIL_TRIAGE"]);
});

test("all opaque citations go directly to distinct person-source queue", async () => {
  const f = fixture();
  f.input.approveTriage = async () => {
    f.actions.push("triage");
    return { code: "EMAIL_TRIAGE_DIRECT_SOURCE_REQUIRED" };
  };
  const result = await tickFullRunStages(f.db, f.input);
  assert.equal(result.status, "SOURCE_PREPARE");
  assert.deepEqual(f.actions, ["triage", "stage:SOURCE_PREPARE"]);
});

test("running email-triage is not repeated on restart", async () => {
  const f = fixture({ triageStatus: "RUNNING" });
  const result = await tickFullRunStages(f.db, f.input);
  assert.equal(result.status, "EMAIL_TRIAGE");
  assert.deepEqual(f.actions, ["stage:EMAIL_TRIAGE"]);
});

test("terminal public inspection advances without duplicate web authorization", async () => {
  const f = fixture({ stage: "EMAIL_TRIAGE", triageStatus: "COMPLETED" });
  const result = await tickFullRunStages(f.db, f.input);
  assert.equal(result.status, "SOURCE_PREPARE");
  assert.deepEqual(f.actions, ["stage:SOURCE_PREPARE"]);
});

test("source stage preparation consumes only the originally approved tariff", async () => {
  const f = fixture({ stage: "SOURCE_PREPARE" });
  const result = await tickFullRunStages(f.db, f.input);
  assert.equal(result.status, "SOURCE_RUNNING");
  assert.deepEqual(f.actions,
    ["queue", "source-approval", "stage:SOURCE_RUNNING"]);
});

test("pre-existing persisted source approval resumes without extra authorization", async () => {
  const f = fixture({ stage: "SOURCE_PREPARE", sourceStatus: "RUNNING" });
  const result = await tickFullRunStages(f.db, f.input);
  assert.equal(result.status, "SOURCE_RUNNING");
  assert.deepEqual(f.actions, ["stage:SOURCE_RUNNING"]);
});

test("changed provider or vanished price blocks automatic paid stage", async () => {
  const f = fixture({ stage: "SOURCE_PREPARE", model: "other-model" });
  const result = await tickFullRunStages(f.db, f.input);
  assert.equal(result.status, "NEEDS_REVIEW");
  assert.deepEqual(f.actions, ["queue", "stage:NEEDS_REVIEW"]);
});

test("100 verified person emails are ready for review; never auto-sent", async () => {
  const f = fixture({ stage: "SOURCE_RUNNING", qualified: 100 });
  const result = await tickFullRunStages(f.db, f.input);
  assert.equal(result.status, "READY_FOR_REVIEW");
  assert.deepEqual(f.actions, ["stage:READY_FOR_REVIEW"]);
});

test("completed source stage with 0 emails remains partial", async () => {
  const f = fixture({ stage: "SOURCE_RUNNING",
    sourceStatus: "COMPLETED", qualified: 0 });
  const result = await tickFullRunStages(f.db, f.input);
  assert.equal(result.status, "PARTIAL");
  assert.equal(result.code, "QUALIFIED_TARGET_NOT_REACHED");
});

test("empty discovery is partial, not completed", async () => {
  const f = fixture({ observations: 0 });
  const result = await tickFullRunStages(f.db, f.input);
  assert.equal(result.status, "PARTIAL");
  assert.deepEqual(f.actions, ["stage:PARTIAL"]);
});

test("expired approval never starts public inspection or paid source call", async () => {
  const f = fixture({ expires: true });
  const result = await tickFullRunStages(f.db, f.input);
  assert.equal(result.status, "NEEDS_REVIEW");
  assert.deepEqual(f.actions, ["stage:NEEDS_REVIEW"]);
});

test("revoked membership cannot transition a saved full-run stage", async () => {
  let didWrite = false;
  const db = { $transaction: async fn => fn({
    $queryRaw: async chunks => {
      if (chunks.join("?").includes('FROM "PartnerMembership"')) return [];
      throw new Error("Unexpected SQL");
    },
    researchFullRun: { updateMany: async () => { didWrite = true; } },
  }) };
  const result = await transitionFullRunStage(db, scope, {
    from: "DISCOVERY", to: "SOURCE_PREPARE", code: "DONE", now,
  });
  assert.equal(result.code, "WORKSPACE_ACCESS_REVOKED");
  assert.equal(didWrite, false);
});
