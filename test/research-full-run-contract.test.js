import test from "node:test";
import assert from "node:assert/strict";
import { validateFullRunScope }
  from "../server/research-full-run-contract.js";
import { approveCampaignRun, stopApprovedCampaignRun }
  from "../server/research-campaign-run-approval.js";
import { requireResearchPriceEnvelope }
  from "../server/research-price-policy.js";

const campaignId = "cmabcdefghijklmnopqrstu";
const workspaceId = "cmabcdefghijklmnopqrstv";
const ownerId = "cmabcdefghijklmnopqrstw";
const price = requireResearchPriceEnvelope({
  provider: "gemini", model: "gemini-3-flash-preview",
});
const discovery = { maxTasks: 12,
  maxWorstCaseCents: 12 * price.worstCaseCents,
  confirmConservativeBudget: true, confirmNoAutomaticRetry: true };
const fullRun = { maxSourceCalls: 30, maxEmailInspectionPages: 250,
  maxTotalWorstCaseCents: discovery.maxWorstCaseCents +
    30 * price.worstCaseCents,
  confirmPublicInspection: true,
  confirmNoAutomaticRetry: true, confirmNoAutomaticSending: true };
const input = { ...discovery, fullRun };

test("upfront multi-stage ceiling cannot expand outside the single approval", () => {
  const charter = validateFullRunScope(fullRun, discovery, price);
  assert.equal(charter.maxSourceCalls, 30);
  assert.equal(charter.maxSourceWorstCaseCents, 30 * price.worstCaseCents);
  assert.equal(charter.maxTotalWorstCaseCents,
    discovery.maxWorstCaseCents + charter.maxSourceWorstCaseCents);
  assert.equal(charter.publicInspectionAuthorized, true);
  for (const invalid of [
    { ...fullRun, maxSourceCalls: 251 },
    { ...fullRun, maxSourceCalls: 0 },
    { ...fullRun, confirmPublicInspection: false },
    { ...fullRun, confirmNoAutomaticRetry: false },
    { ...fullRun, confirmNoAutomaticSending: false },
    { ...fullRun, maxTotalWorstCaseCents: fullRun.maxTotalWorstCaseCents + 1 },
    { ...fullRun, untrustedProvider: "openai" },
  ]) assert.throws(() => validateFullRunScope(invalid, discovery, price), TypeError);
});

function fixture({ prior = null, priorFull = null, revocation = false,
  campaignStatus = "QUEUED", taskAttempts = 0,
  observed = 0, workspaceUsed = 0, personalUsed = 0,
  personalLimit = 100 } = {}) {
  const calls = [];
  const db = {
    aiSetting: { findUnique: async () => ({
      provider: "gemini", model: "gemini-3-flash-preview",
    }) },
    $transaction: async fn => fn({
      $queryRaw: async parts => {
        const sql = parts.join("?");
        if (sql.includes('FROM "PartnerMembership"')) {
          return revocation ? [] : [{ revokedAt: null }];
        }
        if (sql.includes('FROM "ResearchCampaign"')) {
          return [{ id: campaignId, status: campaignStatus }];
        }
        throw new Error("Unexpected SQL");
      },
      researchCampaignRun: {
        findUnique: async () => prior,
        create: async ({ data }) => {
          calls.push("discovery");
          return { id: "cmabcdefghijklmnopqrs1", ...data,
            startedTasks: 0, committedWorstCaseCents: 0, status: "APPROVED" };
        },
      },
      researchFullRun: {
        findUnique: async () => priorFull,
        create: async ({ data }) => {
          calls.push("full-run");
          return { id: "cmabcdefghijklmnopqrs2",
            status: "DISCOVERY", ...data };
        },
      },
      researchCampaign: {
        findUnique: async () => ({ targetCount: 100 }),
      },
      partner: {
        findUnique: async () => ({ researchDailyLimit: 1000 }),
      },
      researchUserLimits: {
        findUnique: async () => ({ dailyLimit: personalLimit }),
      },
      researchDailyQuota: {
        findMany: async ({ where }) => where.scopeKey.in.map(key => ({
          scopeKey: key,
          attempts: key.startsWith("workspace-user:") ? personalUsed : workspaceUsed,
        })),
      },
      researchCampaignTask: { count: async () => taskAttempts },
      researchCampaignObservation: { count: async () => observed },
      auditEvent: { create: async ({ data }) => {
        calls.push("audit");
        assert.equal(data.metadata.sendingEnabled, false);
        // Legacy discovery approvals never claim this new optional permission.
        assert.equal(data.metadata.contactAcceptanceAuthorized ?? false, false);
      } },
    }),
  };
  return { db, calls };
}

test("one approved action commits discovery and source grants atomically", async () => {
  const state = fixture();
  const result = await approveCampaignRun(state.db,
    { campaignId, workspaceId, ownerId, input });
  assert.equal(result.status, 201);
  assert.equal(result.code, "FULL_RUN_APPROVED");
  assert.equal(result.fullRun.targetQualifiedContacts, 100);
  assert.equal(result.fullRun.maxSourceCalls, 30);
  assert.equal(result.fullRun.contactAcceptanceAuthorized, false);
  assert.equal(result.fullRun.sendingEnabled, false);
  assert.deepEqual(state.calls, ["discovery", "full-run", "audit"]);
});

test("new full-run requires today's combined discovery/source quota headroom", async () => {
  // 12 + 30 requests = 42. Workspace cap is 100; user can raise only
  // their personal limit. Approving a new run never reserves quota.
  const quota = fixture({ workspaceUsed: 65, personalUsed: 40, personalLimit: 100 });
  const denied = await approveCampaignRun(quota.db,
    { campaignId, workspaceId, ownerId, input });
  assert.equal(denied.status, 409);
  assert.equal(denied.code, "DAILY_QUOTA_INSUFFICIENT");
  assert.equal(denied.requestedCalls, 42);
  assert.equal(denied.dailyQuota.remaining, 35);
  assert.deepEqual(quota.calls, []);

  const personal = fixture({ workspaceUsed: 0, personalUsed: 3, personalLimit: 40 });
  const personalDenied = await approveCampaignRun(personal.db,
    { campaignId, workspaceId, ownerId, input });
  assert.equal(personalDenied.code, "DAILY_QUOTA_INSUFFICIENT");
  assert.equal(personalDenied.dailyQuota.remaining, 37);
  assert.deepEqual(personal.calls, []);
});

test("revoked membership and started discovery cannot acquire full-run grants", async () => {
  for (const [opts, code] of [
    [{ revocation: true }, "WORKSPACE_ACCESS_REVOKED"],
    [{ campaignStatus: "COMPLETED" }, "CAMPAIGN_NOT_EXECUTABLE"],
    [{ taskAttempts: 1 }, "CAMPAIGN_ALREADY_STARTED"],
    [{ observed: 1 }, "CAMPAIGN_ALREADY_STARTED"],
  ]) {
    const f = fixture(opts);
    const result = await approveCampaignRun(f.db,
      { campaignId, workspaceId, ownerId, input });
    assert.equal(result.code, code);
    assert.deepEqual(f.calls, []);
  }
});

test("pre-existing discovery-only grant cannot silently be upgraded", async () => {
  const f = fixture({ prior: {
    id: "existing", campaignId, workspaceId, ownerId,
    provider: "gemini", model: "gemini-3-flash-preview",
    priceVersion: price.priceVersion,
    maxTasks: discovery.maxTasks,
    maxWorstCaseCents: discovery.maxWorstCaseCents,
  } });
  const result = await approveCampaignRun(f.db,
    { campaignId, workspaceId, ownerId, input });
  assert.equal(result.code, "RUN_APPROVAL_IMMUTABLE");
  assert.deepEqual(f.calls, []);
});

test("legacy discovery approval contract remains strict, without inspection consent", async () => {
  const f = fixture();
  const result = await approveCampaignRun(f.db, {
    campaignId, workspaceId, ownerId, input: discovery,
  });
  assert.equal(result.code, "RUN_APPROVED");
  assert.deepEqual(f.calls, ["discovery", "audit"]);
  assert.equal(result.fullRun, undefined);
});

test("one stop after discovery cancels future source and inspection work", async () => {
  const actions = [];
  const run = { ...scopeForStop(), status: "COMPLETED",
    id: "run-id", startedTasks: 12,
    committedWorstCaseCents: discovery.maxWorstCaseCents };
  const db = { $transaction: async fn => fn({
    $queryRaw: async parts => {
      const sql = parts.join("?");
      if (sql.includes('FROM "PartnerMembership"'))
        return [{ revokedAt: null }];
      if (sql.includes('FROM "ResearchCampaign"'))
        return [{ id: campaignId }];
      throw Error("Unexpected SQL");
    },
    researchCampaignRun: {
      findUnique: async () => run,
      update: async () => { throw Error("Completed discovery remains terminal"); },
    },
    researchFullRun: {
      findUnique: async () => ({
        id: "full-id", campaignId, ownerId, workspaceId,
        status: "SOURCE_RUNNING",
      }),
      updateMany: async ({ data }) => {
        actions.push("full:" + data.status);
        return { count: 1 };
      },
    },
    researchPersonSourceApproval: {
      updateMany: async ({ data }) => {
        actions.push("source:" + data.status);
        return { count: 1 };
      },
    },
    researchPersonSourceCycle: {
      updateMany: async ({ data }) => {
        actions.push("cycle:" + data.status);
        return { count: 1 };
      },
    },
    researchCampaign: {
      updateMany: async ({ data }) => {
        actions.push("triage:" + data.emailTriageStatus);
        return { count: 1 };
      },
    },
    auditEvent: { create: async ({ data }) => {
      actions.push("audit");
      assert.equal(data.metadata.fullRunStopped, true);
      assert.equal(data.metadata.sendingEnabled, false);
    } },
  }) };
  const result = await stopApprovedCampaignRun(db, {
    campaignId, workspaceId, ownerId,
  });
  assert.equal(result.code, "RUN_STOPPED");
  assert.equal(result.fullRunStopped, true);
  assert.equal(result.run.status, "COMPLETED");
  assert.deepEqual(actions,
    ["full:STOPPED", "source:STOPPED", "cycle:STOPPED", "triage:PAUSED", "audit"]);
});

function scopeForStop() {
  return { campaignId, workspaceId, ownerId,
    provider: "gemini", model: "gemini-3-flash-preview",
    priceVersion: price.priceVersion,
    maxTasks: discovery.maxTasks,
    maxWorstCaseCents: discovery.maxWorstCaseCents,
  };
}
