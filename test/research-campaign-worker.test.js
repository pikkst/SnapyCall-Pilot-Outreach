import test from "node:test";
import assert from "node:assert/strict";
import { runOneCampaignTask, ResearchWorkerPreflightError,
  calculateCampaignVerifiedSpendCents, resolveCampaignResearchExecution
} from "../server/research-campaign-worker.js";

const campaignId = "cmabcdefghijklmnopqrstu";
const workspaceId = "cmabcdefghijklmnopqrstv";
const ownerId = "cmabcdefghijklmnopqrstw";
const now = new Date("2026-11-16T15:00:00.000Z");
const input = { campaignId, workspaceId, ownerId, encryptionKey: "test-only-encryption-key" };

function fakeDatabase({ queued = true, member = true,
  memberAtCommit = true, providerResult = "ok", failedCAS = false,
  settlementUnavailable = false, certifiedUsage = null, approvedRun = false,
  failedZeroEvidenceCAS = false, pacingWaitMs = 0 } = {}) {
  const events = [];
  let reservation;
  let membershipLocks = 0;
  const tx = {
    $queryRaw: async (strings) => {
      const sql = strings.join("?");
      if (sql.includes('SELECT "revokedAt" FROM "PartnerMembership"')) {
        membershipLocks++;
        return member && (membershipLocks === 1 || memberAtCommit) ?
          [{ revokedAt: null }] : [];
      }
      if (sql.includes('FROM "ResearchCampaign"')) return [{ id: campaignId }];
      if (sql.includes('FROM "ResearchCampaignTask"')) return queued ?
        [{ id: "task-1", attempts: 0, query: "AI workflow consultants", resultLimit: 10 }] : [];
      if (sql.includes('FROM "ResearchUserLimits"')) return [
        { dailyLimit: 50, maxCandidates: 10, maxConcurrent: 1 },
      ];
      if (sql.includes('SELECT "id" FROM "Partner"')) return [{ id: workspaceId }];
      if (sql.includes('AS "waitMs"')) return [{ waitMs: pacingWaitMs }];
      if (sql.includes('FROM "ResearchRunLease"')) return [{ workspace: 0, user: 0 }];
      if (sql.includes('SELECT "monthlyLimitCents"')) return [{ monthlyLimitCents: 10000 }];
      if (sql.includes('INSERT INTO "ResearchDailyQuota"')) return [{ attempts: 1 }];
      if (sql.includes('SELECT "ownerId" FROM "ResearchOwnerBudget"')) return [{ ownerId }];
      throw new Error("Unexpected database SQL: " + sql);
    },
    $executeRaw: async () => { events.push("concurrency-reserved"); return 1; },
    researchCampaignTask: {
      // Claim sees no uncertain tasks; after commit one queued task remains.
      count: async ({ where }) => where.status === "QUEUED" ? 1 : 0,
      update: async () => { events.push("task-claimed"); },
      findUnique: async () => ({ taskIndex: 0 }),
      findMany: async () => [
        { taskIndex: 0, status: "COMPLETED", observedCount:
          providerResult === "ok" ? 1 : 0 },
      ],
      updateMany: async ({ data }) => {
        events.push("task-" + data.status.toLowerCase());
        return { count: (failedCAS && data.status === "PAUSED") ||
          (failedZeroEvidenceCAS && data.status === "COMPLETED") ? 0 : 1 };
      },
    },
    researchCampaign: {
      findFirst: async () => ({ targetCount: 100 }),
      updateMany: async () => ({ count: 1 }),
    },
    researchCampaignRun: {
      findUnique: async () => approvedRun ? {
        id: "run-1", campaignId, workspaceId, ownerId,
        provider: "gemini", model: "gemini-2.5-flash",
        priceVersion: "gemini-2.5-flash-grounded-prompt-2026-11-16",
        worstCasePerCallCents: 200, maxTasks: 3, startedTasks: 0,
        maxWorstCaseCents: 600, committedWorstCaseCents: 0,
        status: "APPROVED", expiresAt: new Date("2099-01-01T00:00:00Z"),
      } : null,
      updateMany: async () => { events.push("run-allowance-reserved"); return { count: 1 }; },
    },
    researchOwnerBudget: {},
    researchSpendReservation: {
      findUnique: async () => reservation ?? null,
      create: async ({ data }) => {
        events.push("money-reserved");
        reservation = { ...data, status: "RESERVED" };
        return reservation;
      },
      update: async ({ data }) => {
        if (settlementUnavailable) throw new Error("Test settlement unavailable");
        events.push("money-settled");
        reservation = { ...reservation, ...data };
        return reservation;
      },
    },
    researchSpendMonth: {
      upsert: async () => ({ reservedCents: 0, settledCents: 0 }),
      update: async () => ({}),
    },
    auditEvent: { create: async () => ({ id: "audit" }) },
    researchCampaignObservation: {
      count: async () => 1,
      createMany: async ({ data }) => {
      events.push("evidence-saved");
      assert.equal(data[0].status, "UNVERIFIED");
      return { count: data.length };
    } },
  };
  const db = {
    $transaction: callback => callback(tx),
    aiSetting: { findUnique: async () => ({
      provider: "gemini", model: "gemini-2.5-flash",
      encryptedApiKey: "ciphertext-not-real",
    }) },
    partnerMembership: { findUnique: async () => member ? ({
      id: "membership-1", revokedAt: null,
      user: { id: ownerId, googleSub: "subject-1" },
    }) : null },
    researchRunLease: { updateMany: async () => {
      events.push("concurrency-released"); return { count: 1 };
    } },
    auditEvent: { create: async ({ data }) => {
      if (data.action === "research.campaign.execution.paused") {
        events.push("pause-diagnostic-audited");
        assert.equal(data.metadata.workspaceId, workspaceId);
        assert.equal(data.metadata.campaignId, campaignId);
        assert.equal(data.metadata.provider, "gemini");
        assert.equal(data.metadata.code, "BILLING_UNCERTAIN");
        assert.equal(data.metadata.automaticRetryAllowed, false);
        assert.ok(!JSON.stringify(data.metadata).includes("test-only-provider-key"));
        return;
      }
      events.push("diagnostic-audited");
      assert.equal(data.action, "research.campaign.evidence.rejected");
      assert.deepEqual(data.metadata, {
        workspaceId, campaignId, phase: "EVIDENCE_VALIDATION",
        code: providerResult === "invalid-output" ?
          "NO_USABLE_STRUCTURED_OUTPUT" : "NO_VERIFIABLE_GROUNDING",
        provider: "gemini",
        billedCallPossible: true, automaticRetryAllowed: false,
      });
    } },
  };
  const search = async ({ query, limit, provider, model, apiKey }) => {
    events.push("provider-called");
    assert.equal(query, "AI workflow consultants");
    assert.equal(limit, 10);
    assert.equal(provider, "gemini");
    assert.equal(model, "gemini-2.5-flash");
    assert.equal(apiKey, "test-only-provider-key");
    if (providerResult === "fails") throw new Error("Provider request timed out");
    if (providerResult === "no-grounding") {
      throw Object.assign(new Error("Sanitized no-grounding failure"), {
        code: "NO_VERIFIABLE_GROUNDING", phase: "EVIDENCE_VALIDATION",
      });
    }
    if (providerResult === "invalid-output") {
      throw Object.assign(new Error("Sanitized unusable candidate output"), {
        code: "NO_USABLE_STRUCTURED_OUTPUT", phase: "EVIDENCE_VALIDATION",
      });
    }
    const url = "https://example.org/people/ada";
    return {
      candidates: [{ name: "Ada Expert", category: "AI_AUTOMATION",
        sourceUrl: url, rationale: "Publicly documented AI workflow specialist." }],
      sources: [{ url, title: "Ada Expert" }],
      usage: certifiedUsage ?? {},
    };
  };
  return { db, events, search, getReservation: () => reservation };
}

test("worker reserves money and quota before a single provider call, then stores evidence", async () => {
  const { db, events, search, getReservation } = fakeDatabase();
  const output = await runOneCampaignTask(db, input, {
    search, decrypt: () => "test-only-provider-key", now: () => now,
  });
  assert.equal(output.status, "COMPLETED");
  assert.equal(output.observed, 1);
  assert.equal(output.uniqueAdded, 1);
  assert.equal(output.sendingEnabled, false);
  assert.equal(events.filter(x => x === "provider-called").length, 1);
  assert.ok(events.indexOf("money-reserved") < events.indexOf("provider-called"));
  assert.ok(events.indexOf("money-settled") < events.indexOf("evidence-saved"));
  assert.equal(getReservation().chargedCents, 200);
  assert.equal(events.at(-1), "concurrency-released");
});

test("DB pacing rejects a second paid task with no provider, money or quota use", async () => {
  const { db, events, search } = fakeDatabase({ pacingWaitMs: 18_200 });
  await assert.rejects(() => runOneCampaignTask(db, input, {
    search, decrypt: () => "test-only-provider-key", now: () => now,
  }), error => error.name === "ResearchPacingRequired" &&
    error.retryAfterSeconds === 19);
  assert.equal(events.includes("provider-called"), false);
  assert.equal(events.includes("money-reserved"), false);
  assert.equal(events.includes("task-claimed"), false);
  assert.equal(events.includes("concurrency-reserved"), false);
});

test("worker does not spend or call provider if there is no queued task", async () => {
  const { db, events, search } = fakeDatabase({ queued: false });
  assert.deepEqual(await runOneCampaignTask(db, input, {
    search, decrypt: () => "test-only-provider-key", now: () => now,
  }), { status: "NO_READY_TASK", attempted: false });
  assert.ok(!events.includes("money-reserved"));
  assert.ok(!events.includes("provider-called"));
});

test("revoked workspace membership blocks claim with zero provider calls", async () => {
  const { db, events, search } = fakeDatabase({ member: false });
  const output = await runOneCampaignTask(db, input, {
    search, decrypt: () => "test-only-provider-key", now: () => now,
  });
  assert.equal(output.status, "NO_READY_TASK");
  assert.ok(!events.includes("provider-called"));
});

test("provider timeout conservatively settles full reservation and pauses task", async () => {
  const { db, events, search, getReservation } = fakeDatabase({ providerResult: "fails" });
  const output = await runOneCampaignTask(db, input, {
    search, decrypt: () => "test-only-provider-key", now: () => now,
  });
  assert.equal(output.status, "PAUSED");
  assert.equal(output.code, "BILLING_UNCERTAIN");
  assert.equal(output.attempted, true);
  assert.equal(getReservation().chargedCents, 200);
  assert.ok(events.includes("task-paused"));
  assert.ok(!events.includes("evidence-saved"));
  assert.equal(events.at(-1), "concurrency-released");
});

test("missing BYOK settings fail before any charge", async () => {
  const { db, events, search } = fakeDatabase();
  db.aiSetting.findUnique = async () => null;
  await assert.rejects(() => runOneCampaignTask(db, input, {
    search, decrypt: () => "test-only-provider-key", now: () => now,
  }), error => error instanceof ResearchWorkerPreflightError &&
    error.code === "RESEARCH_AI_SETTINGS_REQUIRED");
  assert.ok(!events.includes("money-reserved"));
});

test("revocation during provider call cannot commit evidence or refund uncertain usage", async () => {
  const { db, events, search, getReservation } = fakeDatabase({
    memberAtCommit: false,
  });
  const outcome = await runOneCampaignTask(db, input, {
    search, decrypt: () => "test-only-provider-key", now: () => now,
  });
  assert.equal(outcome.status, "PAUSED");
  assert.equal(outcome.code, "BILLING_UNCERTAIN");
  assert.equal(getReservation().chargedCents, 200);
  assert.ok(!events.includes("evidence-saved"));
  assert.ok(events.includes("task-paused"));
});

test("explicit task claim does not permit unverified workspace or owner input", async () => {
  const { db, search } = fakeDatabase();
  await assert.rejects(() => runOneCampaignTask(db, {
    ...input, workspaceId: "attacker-controlled",
  }, { search, decrypt: () => "test-only-provider-key", now: () => now }),
  TypeError);
});

test("failed task CAS never claims to have persisted a PAUSED status", async () => {
  const { db, search, getReservation } = fakeDatabase({
    providerResult: "fails", failedCAS: true,
  });
  const output = await runOneCampaignTask(db, input, {
    search, decrypt: () => "test-only-provider-key", now: () => now,
  });
  assert.equal(output.status, "RECOVERY_REQUIRED");
  assert.equal(output.code, "TASK_LEASE_STATE_UNCONFIRMED");
  assert.equal(getReservation().chargedCents, 200);
});

test("failed settlement never claims successful or safely paused execution", async () => {
  const { db, search, getReservation } = fakeDatabase({
    providerResult: "fails", settlementUnavailable: true,
  });
  const output = await runOneCampaignTask(db, input, {
    search, decrypt: () => "test-only-provider-key", now: () => now,
  });
  assert.equal(output.status, "RECONCILIATION_REQUIRED");
  assert.equal(output.code, "RESEARCH_SPEND_RECONCILIATION_REQUIRED");
  assert.equal(getReservation().status, "RESERVED");
});

test("terminal uncited Gemini response completes as zero evidence, charges conservatively and never repeats", async () => {
  const { db, events, search, getReservation } =
    fakeDatabase({ providerResult: "no-grounding" });
  const output = await runOneCampaignTask(db, input, {
    search, decrypt: () => "test-only-provider-key", now: () => now,
  });
  assert.equal(output.status, "COMPLETED");
  assert.equal(output.code, "NO_VERIFIABLE_GROUNDING");
  assert.equal(output.observed, 0);
  assert.equal(output.uniqueAdded, 0);
  assert.equal(output.attempted, true);
  assert.equal(output.sendingEnabled, false);
  assert.equal(getReservation().chargedCents, 200);
  assert.equal(getReservation().status, "SETTLED");
  assert.equal(events.filter(x => x === "provider-called").length, 1);
  assert.equal(events.filter(x => x === "diagnostic-audited").length, 1);
  assert.ok(events.includes("task-completed"));
  assert.ok(!events.includes("task-paused"));
  assert.ok(!events.includes("evidence-saved"));
  assert.ok(events.indexOf("money-settled") < events.indexOf("task-completed"));
  assert.equal(events.filter(x => x === "money-settled").length, 1);
});

test("an unknown billed provider failure logs only a bounded reason and never replays", async () => {
  const { db, events, search, getReservation } =
    fakeDatabase({ providerResult: "fails" });
  const result = await runOneCampaignTask(db, input, {
    search, decrypt: () => "test-only-provider-key", now: () => now,
  });
  assert.equal(result.status, "PAUSED");
  assert.equal(result.code, "BILLING_UNCERTAIN");
  assert.equal(getReservation().chargedCents, 200);
  assert.equal(events.filter(e => e === "provider-called").length, 1);
  assert.equal(events.filter(e => e === "pause-diagnostic-audited").length, 1);
  assert.ok(!events.includes("task-completed"));
});

test("uncited terminal response with failed evidence transaction remains PAUSED, not a false success", async () => {
  const { db, events, search, getReservation } =
    fakeDatabase({ providerResult: "no-grounding", failedZeroEvidenceCAS: true });
  const output = await runOneCampaignTask(db, input, {
    search, decrypt: () => "test-only-provider-key", now: () => now,
  });
  assert.equal(output.status, "PAUSED");
  assert.equal(output.code, "BILLING_UNCERTAIN");
  assert.equal(output.diagnosticCode, "NO_VERIFIABLE_GROUNDING");
  assert.equal(getReservation().chargedCents, 200);
  assert.ok(events.includes("task-paused"));
  assert.ok(!events.includes("evidence-saved"));
  assert.equal(events.filter(x => x === "provider-called").length, 1);
});

test("uncited terminal response with unavailable spend settlement cannot be finalized", async () => {
  const { db, events, search, getReservation } =
    fakeDatabase({ providerResult: "no-grounding", settlementUnavailable: true });
  const output = await runOneCampaignTask(db, input, {
    search, decrypt: () => "test-only-provider-key", now: () => now,
  });
  assert.equal(output.status, "RECONCILIATION_REQUIRED");
  assert.equal(output.code, "RESEARCH_SPEND_RECONCILIATION_REQUIRED");
  assert.equal(getReservation().status, "RESERVED");
  assert.ok(events.includes("task-paused"));
  assert.ok(!events.includes("task-completed"));
});

test("worker settles certified Gemini grounded-prompt price once, not full reserve", async () => {
  const certifiedUsage = {
    inputTokens: 1000, outputTokens: 300, groundedPrompts: 1,
    searchRequests: 12,
    billingEvidence: {
      source: "provider", complete: true, provider: "gemini",
      contractVersion: "gemini-2.5-google-search-grounded-prompt-v1",
      billingUnit: "grounded_prompts",
    },
  };
  const { db, events, search, getReservation } = fakeDatabase({ certifiedUsage });
  const output = await runOneCampaignTask(db, input, {
    search, decrypt: () => "test-only-provider-key", now: () => now,
  });
  assert.equal(output.status, "COMPLETED");
  assert.equal(getReservation().reservedCents, 200);
  assert.equal(getReservation().chargedCents, 4);
  assert.equal(getReservation().status, "SETTLED");
  assert.equal(events.filter(x => x === "provider-called").length, 1);
  assert.equal(events.filter(x => x === "money-settled").length, 1);
  assert.ok(events.indexOf("money-settled") < events.indexOf("evidence-saved"));
});

test("legacy manual execute-next cannot bypass an existing autonomous approval", async () => {
  const { db, events, search } = fakeDatabase({ approvedRun: true });
  await assert.rejects(() => runOneCampaignTask(db, input, {
    search, decrypt: () => "test-only-provider-key", now: () => now,
  }), error => error?.code === "RUN_REQUIRES_AUTONOMOUS_EXECUTOR");
  assert.equal(events.includes("provider-called"), false);
  assert.equal(events.includes("money-reserved"), false);
});

test("authorized executor consumes run allowance before a provider call", async () => {
  const { db, events, search } = fakeDatabase({ approvedRun: true });
  const result = await runOneCampaignTask(db, {
    ...input, autonomousApproved: true,
  }, { search, decrypt: () => "test-only-provider-key", now: () => now });
  assert.equal(result.status, "COMPLETED");
  assert.ok(events.indexOf("run-allowance-reserved") <
    events.indexOf("money-reserved"));
  assert.ok(events.indexOf("money-reserved") <
    events.indexOf("provider-called"));
});

test("trusted STOP-terminal malformed candidate output is conservatively settled and completed once", async () => {
  const { db, events, search, getReservation } =
    fakeDatabase({ providerResult: "invalid-output" });
  const result = await runOneCampaignTask(db, input, {
    search, decrypt: () => "test-only-provider-key", now: () => now,
  });
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.code, "NO_USABLE_STRUCTURED_OUTPUT");
  assert.equal(result.observed, 0);
  assert.equal(result.uniqueAdded, 0);
  assert.equal(result.sendingEnabled, false);
  assert.equal(getReservation().chargedCents, 200);
  assert.equal(getReservation().status, "SETTLED");
  assert.equal(events.filter(e => e === "provider-called").length, 1);
  assert.equal(events.filter(e => e === "diagnostic-audited").length, 1);
  assert.ok(events.includes("task-completed"));
  assert.ok(!events.includes("task-paused"));
  assert.ok(!events.includes("evidence-saved"));
});

test("unusable terminal output cannot claim completion on stale lease", async () => {
  const { db, search, events, getReservation } =
    fakeDatabase({ providerResult: "invalid-output", failedZeroEvidenceCAS: true });
  const result = await runOneCampaignTask(db, input, {
    search, decrypt: () => "test-only-provider-key", now: () => now,
  });
  assert.equal(result.status, "PAUSED");
  assert.equal(result.code, "BILLING_UNCERTAIN");
  assert.equal(result.diagnosticCode, "NO_USABLE_STRUCTURED_OUTPUT");
  assert.equal(getReservation().chargedCents, 200);
  assert.ok(events.includes("task-paused"));
});

test("unusable terminal output does not finalize without completed spend settlement", async () => {
  const { db, search, events, getReservation } =
    fakeDatabase({ providerResult: "invalid-output", settlementUnavailable: true });
  const result = await runOneCampaignTask(db, input, {
    search, decrypt: () => "test-only-provider-key", now: () => now,
  });
  assert.equal(result.status, "RECONCILIATION_REQUIRED");
  assert.equal(result.code, "RESEARCH_SPEND_RECONCILIATION_REQUIRED");
  assert.equal(getReservation().status, "RESERVED");
  assert.ok(!events.includes("task-completed"));
});


test("Gemini 3 remains fail-closed in the real campaign worker before DB claim or paid calls", async () => {
  const { db, events, search } = fakeDatabase({ approvedRun: true });
  db.aiSetting.findUnique = async () => ({
    provider: "gemini",
    model: "gemini-3-flash-preview",
    encryptedApiKey: "test-only-encrypted-key",
  });
  let decryptAttempts = 0;
  await assert.rejects(() => runOneCampaignTask(db, {
    ...input, autonomousApproved: true,
  }, {
    search, decrypt: () => {
      decryptAttempts++;
      return "test-only-provider-key";
    },
    now: () => now,
  }), error => error?.name === "ResearchPricingUnavailable");
  assert.equal(decryptAttempts, 0);
  for (const event of ["provider-called", "money-reserved",
    "task-claimed", "run-allowance-reserved", "concurrency-reserved"]) {
    assert.equal(events.includes(event), false, event);
  }
});


test("campaign worker uses exact dual-provider settlement tariff only when fully attested", () => {
  const price = {
    enforcementReady: true, provider: "gemini",
    model: "gemini-3-flash-preview", retrievalProvider: "tavily",
    billingContractVersion: "tavily-basic-gemini3-text-v1",
    retrieval: { maxRequests: 1, centsPerThousandRequests: 800 },
    textModel: {
      maxInputTokens: 16_384, maxOutputTokens: 2048,
      inputCentsPerMillion: 50, outputCentsPerMillion: 300,
    },
    worstCaseCents: 3,
  };
  const base = { price, provider: "gemini", model: "gemini-3-flash-preview" };
  const usage = {
    retrievalCredits: 1, inputTokens: 850,
    outputTokens: 150, thinkingTokens: 100,
    billingEvidence: {
      source: "trusted_provider_adapters", complete: true,
      contractVersion: price.billingContractVersion,
      retrievalProvider: "tavily", textProvider: "gemini",
      model: "gemini-3-flash-preview",
    },
  };
  assert.equal(calculateCampaignVerifiedSpendCents({ ...base, usage }), 3);
  for (const changed of [
    { ...base, usage: { ...usage, billingEvidence: null } },
    { ...base, usage: { ...usage, thinkingTokens: null } },
    { ...base, usage: { ...usage, retrievalCredits: 0 } },
    { ...base, provider: "openai", usage },
    { ...base, model: "gemini-2.5-flash", usage },
  ]) assert.equal(calculateCampaignVerifiedSpendCents(changed), null);
  // This isn't a real price authorization: the registry blocks Gemini 3
  // independently, before this helper can ever be used for a live task.
});

test("worker does not accept an injected dual-provider stage on a legacy model", async () => {
  const { BoundedResearchStageError } =
    await import("../server/research-provider-adapters.js");
  const { db, events, getReservation } = fakeDatabase();
  const original = db.auditEvent.create;
  const metadata = [];
  db.auditEvent.create = async args => {
    if (args.data.action === "research.campaign.execution.paused") {
      metadata.push(args.data.metadata);
    }
    return original(args);
  };
  const output = await runOneCampaignTask(db, input, {
    search: async () => {
      events.push("provider-called");
      throw new BoundedResearchStageError(
        "DUAL_PROVIDER_OUTCOME_UNCERTAIN", "GEMINI_GENERATE_CONTENT_DISPATCHED");
    },
    decrypt: () => "test-only-provider-key",
    now: () => now,
  });
  assert.equal(output.status, "PAUSED");
  assert.equal(output.code, "BILLING_UNCERTAIN");
  assert.equal(getReservation().chargedCents, 200);
  assert.equal(metadata.length, 1);
  assert.equal(Object.hasOwn(metadata[0], "dualProviderStage"), false);
  assert.equal(metadata[0].automaticRetryAllowed, false);
});



test("dual-provider task plan selects bounded search only with exact reviewed account prerequisites", async () => {
  const { researchTavilyGeminiCandidates, researchCandidates } =
    await import("../server/ai-research.js");
  const price = {
    provider: "gemini", model: "gemini-3-flash-preview",
    billingContractVersion: "tavily-basic-gemini3-text-v1",
    retrievalProvider: "tavily", enforcementReady: true,
    retrieval: { maxRequests: 1 },
    textModel: { maxInputTokens: 16_384, maxOutputTokens: 2048 },
  };
  const valid = {
    provider: "gemini", model: "gemini-3-flash-preview", price,
    search: researchCandidates,
    tavilyApiKey: "tvly-synthetic-test-key",
    tavilyEnabled: true, accountCapVerified: true,
  };
  const plan = resolveCampaignResearchExecution(valid);
  assert.equal(plan.dualProvider, true);
  assert.equal(plan.search, researchTavilyGeminiCandidates);
  assert.equal(plan.maxResults, 20);
  assert.equal(plan.maxInputTokens, 16_384);
  assert.equal(plan.tavilyApiKey, valid.tavilyApiKey);
  assert.equal(Object.isFrozen(plan), true);
  for (const change of [
    { tavilyApiKey: undefined }, { tavilyApiKey: "not-a-key" },
    { tavilyEnabled: false }, { accountCapVerified: false },
    { provider: "openai" }, { model: "gemini-2.5-flash" },
    { price: { ...price, enforcementReady: false } },
    { price: { ...price, textModel: { ...price.textModel, maxInputTokens: 1_000_000 } } },
    { price: { ...price, retrieval: { maxRequests: 2 } } },
    { price: { ...price, textModel: { ...price.textModel, maxOutputTokens: 9999 } } },
  ]) assert.throws(() => resolveCampaignResearchExecution({
    ...valid, ...change,
  }), error => error instanceof ResearchWorkerPreflightError);
  const legacy = resolveCampaignResearchExecution({
    ...valid, price: {
      billingContractVersion: "gemini-2.5-google-search-grounded-prompt-v1",
    },
  });
  assert.equal(legacy.dualProvider, false);
  assert.equal(legacy.search, researchCandidates);
});

test("worker never claims Gemini 3 without an approved registry tariff even with Tavily enabled", async () => {
  const { db, events, search } = fakeDatabase({ approvedRun: true });
  db.aiSetting.findUnique = async () => ({
    provider: "gemini", model: "gemini-3-flash-preview",
    encryptedApiKey: "encrypted-synthetic-gemini-key",
  });
  let calls = 0;
  await assert.rejects(() => runOneCampaignTask(db, input, {
    search,
    decrypt: () => { calls++; return "test-gemini-key"; },
    tavilyApiKey: "tvly-synthetic-test-key",
    tavilyEnabled: true, accountCapVerified: true,
    now: () => now,
  }), error => error.name === "ResearchPricingUnavailable");
  assert.equal(calls, 0);
  for (const event of ["provider-called", "money-reserved",
    "task-claimed", "concurrency-reserved", "run-allowance-reserved"]) {
    assert.equal(events.includes(event), false, event);
  }
});
