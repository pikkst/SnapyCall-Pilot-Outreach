import test from "node:test";
import assert from "node:assert/strict";
import { runOneCampaignTask, ResearchWorkerPreflightError
} from "../server/research-campaign-worker.js";

const campaignId = "cmabcdefghijklmnopqrstu";
const workspaceId = "cmabcdefghijklmnopqrstv";
const ownerId = "cmabcdefghijklmnopqrstw";
const now = new Date("2026-11-16T15:00:00.000Z");
const input = { campaignId, workspaceId, ownerId, encryptionKey: "test-only-encryption-key" };

function fakeDatabase({ queued = true, member = true,
  memberAtCommit = true, providerResult = "ok", failedCAS = false,
  settlementUnavailable = false, certifiedUsage = null } = {}) {
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
      updateMany: async ({ data }) => {
        events.push("task-" + data.status.toLowerCase());
        return { count: failedCAS && data.status === "PAUSED" ? 0 : 1 };
      },
    },
    researchCampaign: {
      findFirst: async () => ({ targetCount: 100 }),
      updateMany: async () => ({ count: 1 }),
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
      events.push("diagnostic-audited");
      assert.equal(data.action, "research.campaign.evidence.rejected");
      assert.deepEqual(data.metadata, {
        workspaceId, campaignId, phase: "EVIDENCE_VALIDATION",
        code: "NO_VERIFIABLE_GROUNDING", provider: "gemini",
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

test("paid but uncited Gemini response pauses, audits reason and never repeats", async () => {
  const { db, events, search, getReservation } =
    fakeDatabase({ providerResult: "no-grounding" });
  const output = await runOneCampaignTask(db, input, {
    search, decrypt: () => "test-only-provider-key", now: () => now,
  });
  assert.deepEqual({
    status: output.status, code: output.code,
    diagnosticCode: output.diagnosticCode, attempted: output.attempted,
  }, {
    status: "PAUSED", code: "BILLING_UNCERTAIN",
    diagnosticCode: "NO_VERIFIABLE_GROUNDING", attempted: true,
  });
  assert.equal(getReservation().chargedCents, 200);
  assert.equal(events.filter(x => x === "provider-called").length, 1);
  assert.equal(events.filter(x => x === "diagnostic-audited").length, 1);
  assert.ok(events.includes("task-paused"));
  assert.ok(!events.includes("evidence-saved"));
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
