import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCampaignObservations, commitCampaignResearchResult,
  summarizeCampaignProgress, deriveCampaignOperationalState, CampaignLeaseConflict
} from "../server/research-campaign-observations.js";

const url1 = "https://example.org/expert/ada";
const url2 = "https://example.org/expert/ben";
const preview = {
  sources: [{ url: url1 }, { url: url2 }],
  candidates: [
    { name: "Ada Smith", category: "AI_AUTOMATION", sourceUrl: url1,
      rationale: "Consultant working with AI workflow automation." },
    { name: "Ben Smith", category: "AI_AUTOMATION", sourceUrl: url2,
      rationale: "Consultant working with AI workflow automation." },
  ],
};

test("campaign normalizer keeps only independently cited, review-only candidates", () => {
  const a = normalizeCampaignObservations(preview, 10);
  assert.equal(a.length, 2);
  assert.equal(a[0].citationUrl, url1);
  assert.equal(a[0].status, "UNVERIFIED");
  assert.equal(a[0].evidenceKey.length, 64);
  assert.equal(a[0].email, undefined);
  assert.deepEqual(a, normalizeCampaignObservations(preview, 10));
  assert.equal(normalizeCampaignObservations({
    ...preview, candidates: [preview.candidates[0], preview.candidates[0]],
  }, 10).length, 1);
});

test("untrusted citation, invalid URL, oversized envelope fail closed", () => {
  assert.throws(() => normalizeCampaignObservations({
    ...preview, sources: [{ url: url1 }],
  }, 10));
  assert.throws(() => normalizeCampaignObservations({
    ...preview, candidates: [{ ...preview.candidates[0], sourceUrl: "http://localhost" }],
  }, 10));
  assert.throws(() => normalizeCampaignObservations({
    ...preview, candidates: Array(21).fill(preview.candidates[0]),
  }, 20));
  assert.throws(() => normalizeCampaignObservations({
    ...preview, candidates: [{ ...preview.candidates[0], category: "FORGED" }],
  }, 10));
  assert.throws(() => normalizeCampaignObservations(preview, 1));
});

test("task completion and evidence writing share a transaction and dedupe", async () => {
  const calls = [];
  const db = { $transaction: async callback => callback({
    $queryRaw: async () => [{ id: "campaign-1" }],
    researchCampaign: { findFirst: async () => ({ targetCount: 100 }) },
    researchCampaignTask: {
      count: async input => input.where.status === "QUEUED" ? 1 : 0,
      findUnique: async () => ({ taskIndex: 1 }),
      findMany: async () => [
        { taskIndex: 1, status: "COMPLETED", observedCount: 2 },
        { taskIndex: 0, status: "COMPLETED", observedCount: 0 },
      ],
      updateMany: async input => {
        calls.push(["fence", input.where.leaseToken, input.data.status]);
        return { count: 1 };
      },
    },
    researchCampaignObservation: {
      count: async () => 1,
      createMany: async input => {
      calls.push(["insert", input.data.length, input.skipDuplicates]);
      assert.equal(input.data[0].campaignId, "campaign-1");
      assert.equal(input.data[0].taskId, "task-1");
      assert.equal(input.data[0].status, "UNVERIFIED");
      return { count: 1 };
    } },
  }) };
  const claim = { campaignId: "campaign-1", taskId: "task-1", workspaceId: "work-1",
    ownerId: "owner-1", leaseToken: "token-1", limit: 10 };
  const result = await commitCampaignResearchResult(db, claim, preview);
  assert.deepEqual(result, { observed: 2, uniqueAdded: 1, duplicates: 1 });
  assert.deepEqual(calls, [["fence", "token-1", "COMPLETED"], ["insert", 2, true]]);
});

test("stale leases cannot write observations", async () => {
  let inserted = false;
  const db = { $transaction: async callback => callback({
    $queryRaw: async () => [{ id: "campaign-1" }],
    researchCampaignTask: { updateMany: async () => ({ count: 0 }) },
    researchCampaignObservation: { createMany: async () => {
      inserted = true;
      return { count: 2 };
    } },
  }) };
  await assert.rejects(
    () => commitCampaignResearchResult(db, { campaignId: "campaign-1", taskId: "task-1",
      workspaceId: "work-1", ownerId: "owner-1", leaseToken: "expired", limit: 10 }, preview),
    CampaignLeaseConflict
  );
  assert.equal(inserted, false);
});

test("progress distinguishes unique candidates from raw observations", () => {
  const progress = summarizeCampaignProgress({
    id: "campaign-1", status: "RUNNING", targetCount: 100,
    _count: { observations: 7 },
    tasks: [
      { status: "COMPLETED", observedCount: 5, resultLimit: 10 },
      { status: "COMPLETED", observedCount: 4, resultLimit: 10 },
      { status: "PAUSED", observedCount: 0, resultLimit: 10 },
      { status: "QUEUED", observedCount: 0, resultLimit: 10 },
    ],
  });
  assert.equal(progress.uniqueSourcedCandidates, 7);
  assert.equal(progress.rawCandidateObservations, 9);
  assert.equal(progress.duplicateObservations, 2);
  assert.equal(progress.targetReached, false);
  assert.equal(progress.tasks.completed, 2);
  assert.equal(progress.tasks.paused, 1);
  assert.equal(progress.contactVerification, "NOT_PERFORMED");
  assert.equal(progress.sendingEnabled, false);
  assert.throws(() => summarizeCampaignProgress({
    id: "campaign-1", status: "RUNNING", targetCount: 100,
    _count: { observations: 1 },
    tasks: [{ status: "FORGED", observedCount: 0, resultLimit: 10 }],
  }));
});

const progressNow = new Date("2026-11-16T15:00:00Z");
const baseProgress = {
  id: "campaign-1", status: "RUNNING", targetCount: 100,
  _count: { observations: 70 },
  tasks: [{ status: "COMPLETED", observedCount: 10, resultLimit: 10 },
    { status: "QUEUED", observedCount: 0, resultLimit: 10 }],
};

test("campaign progress distinguishes a completed uncited search from a blocked billable task", () => {
  const snapshot = summarizeCampaignProgress({
    id: "campaign-1", status: "RUNNING", targetCount: 100,
    _count: { observations: 7 },
    tasks: [
      { status: "COMPLETED", observedCount: 0, resultLimit: 10,
        lastErrorCode: "NO_VERIFIABLE_GROUNDING" },
      { status: "COMPLETED", observedCount: 7, resultLimit: 10,
        lastErrorCode: null },
      { status: "QUEUED", observedCount: 0, resultLimit: 10,
        lastErrorCode: null },
    ],
  });
  assert.equal(snapshot.noGroundingTasks, 1);
  assert.equal(snapshot.tasks.completed, 2);
  assert.equal(snapshot.tasks.paused, 0);
  assert.equal(snapshot.operationalState, "READY");
  assert.equal(snapshot.uniqueSourcedCandidates, 7);
  assert.equal(snapshot.contactVerification, "NOT_PERFORMED");
});

test("campaign status differentiates readiness from actual target completion", () => {
  const ready = deriveCampaignOperationalState(baseProgress, progressNow);
  assert.equal(ready.operationalState, "READY");
  assert.equal(ready.action, "EXECUTE_EXPLICIT_BOUNDED_SLICE");
  const target = deriveCampaignOperationalState({
    ...baseProgress, _count: { observations: 100 },
  }, progressNow);
  assert.equal(target.operationalState, "TARGET_REACHED");
  assert.equal(target.action, "FINALIZE_CAMPAIGN");
  const partial = deriveCampaignOperationalState({
    ...baseProgress, tasks: [{ status: "COMPLETED", observedCount: 5, resultLimit: 10 }],
  }, progressNow);
  assert.equal(partial.operationalState, "PARTIAL");
  assert.equal(partial.action, "FINALIZE_CAMPAIGN");
});

test("expired lease takes precedence over a satisfied target and needs manual reconciliation", () => {
  const state = deriveCampaignOperationalState({
    ...baseProgress, _count: { observations: 101 },
    tasks: [{ status: "RUNNING", observedCount: 0, resultLimit: 10,
      leaseUntil: new Date(progressNow.getTime() - 1) }],
  }, progressNow);
  assert.equal(state.operationalState, "RECOVERY_REQUIRED");
  assert.equal(state.expiredLeases, 1);
  assert.equal(state.needsReconciliation, true);
  assert.equal(state.action, "RECONCILE_EXPIRED_LEASES");
});

test("unsettled, running and terminal states are never silently promoted", () => {
  const paused = deriveCampaignOperationalState({
    ...baseProgress, tasks: [{ status: "PAUSED", observedCount: 0, resultLimit: 10 }],
  }, progressNow);
  assert.equal(paused.operationalState, "PAUSED_REVIEW");
  assert.equal(paused.needsReconciliation, true);
  const running = deriveCampaignOperationalState({
    ...baseProgress, tasks: [{ status: "RUNNING", observedCount: 0, resultLimit: 10,
      leaseUntil: new Date(progressNow.getTime() + 10000) }],
  }, progressNow);
  assert.equal(running.operationalState, "RUNNING");
  const cancelled = deriveCampaignOperationalState({
    ...baseProgress, status: "CANCELLED",
    tasks: [{ status: "PAUSED", observedCount: 0, resultLimit: 10 }],
  }, progressNow);
  assert.equal(cancelled.operationalState, "CANCELLED");
  assert.equal(cancelled.needsReconciliation, true);
});

test("progress snapshot exposes recovery metadata but does not imply verified email", () => {
  const view = summarizeCampaignProgress({
    ...baseProgress, tasks: [{ status: "RUNNING", observedCount: 0,
      resultLimit: 10, leaseUntil: new Date("2020-01-01T00:00:00Z") }],
  });
  assert.equal(view.operationalState, "RECOVERY_REQUIRED");
  assert.equal(view.contactVerification, "NOT_PERFORMED");
  assert.equal(view.sendingEnabled, false);
});

test("future retry window cannot be presented as immediately executable", () => {
  const view = deriveCampaignOperationalState({
    ...baseProgress, tasks: [{ status: "QUEUED", observedCount: 0,
      resultLimit: 10, nextAttemptAt: new Date(progressNow.getTime() + 60000) }],
  }, progressNow);
  assert.equal(view.operationalState, "WAITING_RETRY");
  assert.equal(view.action, "WAIT_FOR_NEXT_ELIGIBLE_TASK");
  const ready = deriveCampaignOperationalState({
    ...baseProgress, tasks: [{ status: "QUEUED", observedCount: 0,
      resultLimit: 10, nextAttemptAt: new Date(progressNow.getTime() - 1) }],
  }, progressNow);
  assert.equal(ready.operationalState, "READY");
});

test("persisted PAUSED campaign cannot be offered as READY", () => {
  const view = deriveCampaignOperationalState({
    ...baseProgress, status: "PAUSED",
  }, progressNow);
  assert.equal(view.operationalState, "PAUSED_REVIEW");
  assert.equal(view.needsReconciliation, true);
});

test("campaign progress reports malformed terminal output separately from missing grounding", () => {
  const result = summarizeCampaignProgress({
    id: "campaign-1", status: "RUNNING", targetCount: 100,
    _count: { observations: 0 },
    tasks: [
      { status: "COMPLETED", observedCount: 0, resultLimit: 10,
        lastErrorCode: "NO_VERIFIABLE_GROUNDING" },
      { status: "COMPLETED", observedCount: 0, resultLimit: 10,
        lastErrorCode: "NO_USABLE_STRUCTURED_OUTPUT" },
      { status: "QUEUED", observedCount: 0, resultLimit: 10,
        lastErrorCode: null },
    ],
  });
  assert.equal(result.noGroundingTasks, 1);
  assert.equal(result.invalidOutputTasks, 1);
  assert.equal(result.uniqueSourcedCandidates, 0);
  assert.equal(result.tasks.paused, 0);
  assert.equal(result.contactVerification, "NOT_PERFORMED");
});

test("fenced third consecutive unusable result atomically stops new paid claims", async () => {
  const updates = [];
  const audit = [];
  const tx = {
    $queryRaw: async () => [{ id: "campaign-1" }],
    researchCampaignTask: {
      updateMany: async args => { updates.push(["task", args.data.status]); return { count: 1 }; },
      findUnique: async () => ({ taskIndex: 2 }),
      findMany: async args => {
        assert.equal(args.where.taskIndex.lte, 2);
        return [
          { taskIndex: 2, status: "COMPLETED", observedCount: 0 },
          { taskIndex: 1, status: "COMPLETED", observedCount: 0 },
          { taskIndex: 0, status: "COMPLETED", observedCount: 0 },
        ];
      },
      count: async () => 0,
    },
    researchCampaign: {
      findFirst: async () => ({ targetCount: 100 }),
      updateMany: async args => { updates.push(["campaign", args.data.status]); return { count: 1 }; },
    },
    researchCampaignObservation: { count: async () => 0 },
    auditEvent: { create: async args => { audit.push(args.data); } },
  };
  const claim = { campaignId: "campaign-1", taskId: "task-3",
    workspaceId: "workspace-1", ownerId: "owner-1",
    leaseToken: "fenced-lease-3", limit: 10 };
  const result = await commitCampaignResearchResult(
    { $transaction: callback => callback(tx) }, claim,
    { candidates: [], sources: [] }, new Date(),
    { completionCode: "NO_USABLE_STRUCTURED_OUTPUT" });
  assert.equal(result.campaignStatus, "QUALITY_STOP");
  assert.deepEqual(updates, [["task", "COMPLETED"], ["campaign", "QUALITY_STOP"]]);
  assert.equal(audit[0].metadata.qualityFailureStreak, 3);
  assert.equal(audit[0].metadata.automaticProviderRetry, false);
  assert.equal(result.observed, 0);
  assert.equal(result.uniqueAdded, 0);
});

test("successful cited task resets sequence and permits following authorized work", async () => {
  const updates = [];
  const tx = {
    $queryRaw: async () => [{ id: "campaign-1" }],
    researchCampaignTask: {
      updateMany: async () => ({ count: 1 }),
      findUnique: async () => ({ taskIndex: 2 }),
      findMany: async () => [
        { taskIndex: 2, status: "COMPLETED", observedCount: 2 },
        { taskIndex: 1, status: "COMPLETED", observedCount: 0 },
        { taskIndex: 0, status: "COMPLETED", observedCount: 0 },
      ],
      count: async args => args.where.status === "QUEUED" ? 1 : 0,
    },
    researchCampaign: {
      findFirst: async () => ({ targetCount: 100 }),
      updateMany: async args => { updates.push(args); return { count: 1 }; },
    },
    researchCampaignObservation: {
      createMany: async () => ({ count: 2 }),
      count: async () => 2,
    },
  };
  const result = await commitCampaignResearchResult(
    { $transaction: callback => callback(tx) },
    { campaignId: "campaign-1", taskId: "task-3", workspaceId: "workspace-1",
      ownerId: "owner-1", leaseToken: "fenced-lease-3", limit: 10 },
    preview);
  assert.equal(result.observed, 2);
  assert.equal(result.campaignStatus, undefined);
  assert.deepEqual(updates, []);
});

test("quality STOP is distinguishable from billing reconciliation in progress", () => {
  const task = i => ({ taskIndex: i, status: "COMPLETED",
    observedCount: 0, resultLimit: 10,
    lastErrorCode: "NO_USABLE_STRUCTURED_OUTPUT" });
  const view = summarizeCampaignProgress({
    id: "campaign-1", status: "QUALITY_STOP", targetCount: 100,
    _count: { observations: 0 },
    tasks: [task(0), task(1), task(2),
      { taskIndex: 3, status: "QUEUED", observedCount: 0, resultLimit: 10 }],
  });
  assert.equal(view.operationalState, "QUALITY_STOP");
  assert.equal(view.needsReconciliation, false);
  assert.equal(view.qualityFailureStreak, 3);
  assert.equal(view.qualityStop, true);
  assert.equal(view.tasks.queued, 1);
  assert.equal(view.contactVerification, "NOT_PERFORMED");
});

test("full-run discovery adds a new task after 100 raw observations without claiming 100 emails", async () => {
  const actions = [];
  const scope = { campaignId: "campaign-1", taskId: "task-23",
    workspaceId: "work-1", ownerId: "owner-1",
    leaseToken: "lease-23", limit: 10 };
  const fixtureCampaign = {
    query: "Find independent AI automation experts worldwide",
    targetCount: 100, planVersion: "ai62-planner-v1",
    idempotencyKey: "6c8d3e48-14fc-4f67-b0c1-e70cf9c48fad",
  };
  const now = new Date("2026-11-18T16:20:00Z");
  let observations = 101;
  const db = { $transaction: async fn => fn({
    $queryRaw: async () => [{ id: "campaign-1" }],
    researchFullRun: { findUnique: async () => ({
      status: "DISCOVERY", workspaceId: "work-1",
      ownerId: "owner-1", maxDiscoveryCalls: 80,
      expiresAt: new Date(now.getTime() + 3600_000),
    }) },
    researchCampaignRun: { findUnique: async () => ({
      status: "RUNNING", workspaceId: "work-1", ownerId: "owner-1",
      maxTasks: 80, startedTasks: 24, maxWorstCaseCents: 800,
      committedWorstCaseCents: 240, worstCasePerCallCents: 10,
      expiresAt: new Date(now.getTime() + 3600_000),
    }) },
    researchCampaign: {
      findFirst: async () => ({ targetCount: 100 }),
      findUnique: async () => fixtureCampaign,
      updateMany: async () => {
        throw Error("Must not finalize at 100 names");
      },
    },
    researchCampaignTask: {
      count: async ({ where }) => where.status?.in ? 0 :
        where.status === "QUEUED" ? 0 : 24,
      findUnique: async () => ({ taskIndex: 23 }),
      findMany: async () => [
        { taskIndex: 23, status: "COMPLETED", observedCount: 2 },
        { taskIndex: 22, status: "COMPLETED", observedCount: 2 },
      ],
      findFirst: async () => ({ taskIndex: 23 }),
      updateMany: async () => ({ count: 1 }),
      create: async ({ data }) => {
        actions.push(data);
        return data;
      },
    },
    researchCampaignObservation: {
      count: async () => observations,
      createMany: async ({ data }) => {
        actions.push({ evidence: data.length });
        observations += data.length;
        return { count: data.length };
      },
    },
  }) };
  const result = await commitCampaignResearchResult(db, scope, preview, now);
  assert.equal(result.uniqueAdded, 2);
  assert.equal(result.campaignStatus, undefined);
  assert.equal(result.inspectionCap, 250);
  assert.equal(actions.length, 2);
  assert.equal(actions[1].taskIndex, 24);
  assert.equal(actions[1].status, "QUEUED");
  assert.equal(actions[1].resultLimit, 10);
});

test("full-run caps model results at last public-inspection slot and cancels remaining paid tasks", async () => {
  const actions = [];
  const now = new Date("2026-11-18T16:20:00Z");
  const scope = { campaignId: "campaign-1", taskId: "task-1",
    workspaceId: "work-1", ownerId: "owner-1",
    leaseToken: "lease-1", limit: 10 };
  const db = { $transaction: async fn => fn({
    $queryRaw: async () => [{ id: "campaign-1" }],
    researchFullRun: { findUnique: async () => ({
      status: "DISCOVERY", workspaceId: "work-1",
      ownerId: "owner-1",
    }) },
    researchCampaign: {
      findFirst: async () => ({ targetCount: 100 }),
      updateMany: async ({ data }) => {
        actions.push("campaign:" + data.status);
        return { count: 1 };
      },
    },
    researchCampaignTask: {
      count: async () => 0,
      findUnique: async () => ({ taskIndex: 1 }),
      findMany: async () => [{ taskIndex: 1, status: "COMPLETED",
        observedCount: 2 }],
      updateMany: async ({ data }) => {
        if (data.status === "CANCELLED") actions.push("tasks:CANCELLED");
        return { count: 1 };
      },
    },
    researchCampaignObservation: {
      count: async () => 250,
      createMany: async ({ data }) => {
        actions.push("saved:" + data.length);
        return { count: data.length };
      },
    },
    auditEvent: { create: async () => { actions.push("audit"); } },
  }) };
  // All 250 slots are already occupied; another model result cannot overflow.
  const result = await commitCampaignResearchResult(db, scope, preview, now);
  assert.equal(result.campaignStatus, "PARTIAL");
  assert.equal(result.uniqueAdded, 0);
  assert.equal(result.omittedAtInspectionCap, 2);
  assert.deepEqual(actions,
    ["tasks:CANCELLED", "campaign:PARTIAL", "audit"]);
});
