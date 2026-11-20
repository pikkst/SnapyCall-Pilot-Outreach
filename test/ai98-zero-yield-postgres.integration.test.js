import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { stopFullRunSourceOnZeroYield } from "../server/research-full-run-stages.js";
import { claimPersonSourceJob } from "../server/research-person-source-executor.js";
import { createNextSourceCycle } from "../server/research-person-source-cycles.js";
import { personSourceFingerprint } from "../server/research-person-source-queue.js";
import { personSourceJobSnapshot } from "../server/research-person-source-approval.js";
import { requireResearchPriceEnvelope } from "../server/research-price-policy.js";

// CI supplies an isolated, migrated PostgreSQL instance. Never point this
// fixture-writing test at production or a manually supplied DATABASE_URL.
const integration = process.env.AI98_TEST_POSTGRES === "isolated-ci";
const price = requireResearchPriceEnvelope({
  provider: "gemini", model: "gemini-3-flash-preview",
});
const future = () => new Date(Date.now() + 60 * 60_000);
async function fixture(db, { futureCycle = false, invalidQueued = false } = {}) {
  const nonce = randomUUID().slice(0, 8);
  const user = await db.partnerUser.create({ data: {
    emailNormalized: `test-${nonce}@example.org`,
    googleSub: `test-sub-${nonce}`,
  } });
  const partner = await db.partner.create({ data: { name: "AI98 DB CI " + nonce } });
  await db.partnerMembership.create({ data: {
    partnerId: partner.id, userId: user.id, role: "PARTNER",
    inviteStatus: "ACCEPTED",
  } });
  const campaign = await db.researchCampaign.create({ data: {
    workspaceId: partner.id, ownerId: user.id,
    idempotencyKey: "db-fixture-" + nonce, query: "verified AI professional",
    targetCount: 100, planVersion: "ai98-db-test", status: "PARTIAL",
  } });
  const task = await db.researchCampaignTask.create({ data: {
    campaignId: campaign.id, taskIndex: 0, taskKey: "test",
    query: "experts", region: "US", facet: "test", resultLimit: 20,
    status: "COMPLETED",
  } });
  const observations = [];
  for (let i = 0; i < 13; i++) {
    const row = await db.researchCampaignObservation.create({ data: {
      campaignId: campaign.id, taskId: task.id,
      evidenceKey: "test-evidence-" + i, name: "Expert Person " + i,
      category: "AI_AUTOMATION", citationUrl: "https://example.org/team",
      rationale: "Explicit test citation", emailTriageStatus: "BLOCKED",
    } });
    observations.push(row);
  }
  const jobs = observations.map((row, i) => ({
    campaignId: campaign.id, observationId: row.id,
    evidenceFingerprint: invalidQueued && i === 12
      ? "f".repeat(64) : personSourceFingerprint(row),
    reason: "PERSON_SOURCE_REQUIRED",
    status: i === 12 ? "QUEUED" : "COMPLETED",
    attempts: i === 12 ? 0 : 1,
    lastErrorCode: i === 12 ? null : "SOURCE_ALL_PAGES_UNAVAILABLE",
    cycleIndex: futureCycle && i === 12 ? 1 : 0,
  }));
  await db.researchPersonSourceJob.createMany({ data: jobs });
  const snapshot = personSourceJobSnapshot(jobs.map(job => ({
    ...job, status: "QUEUED",
  })));
  const scope = { campaignId: campaign.id, workspaceId: partner.id,
    ownerId: user.id };
  await db.researchPersonSourceApproval.create({ data: {
    ...scope, provider: "gemini", model: "gemini-3-flash-preview",
    priceVersion: price.priceVersion,
    worstCasePerCallCents: price.worstCaseCents, maxCalls: 13,
    maxWorstCaseCents: 13 * price.worstCaseCents,
    eligibleJobCount: 13, jobSnapshotHash: snapshot,
    publicInspectionAuthorized: true,
    status: futureCycle ? "COMPLETED" : "RUNNING",
    startedCalls: 12, committedWorstCaseCents: 12 * price.worstCaseCents,
    expiresAt: future(),
  } });
  if (futureCycle) {
    await db.researchPersonSourceCycle.create({ data: {
      ...scope, cycleIndex: 1, provider: "gemini",
      model: "gemini-3-flash-preview",
      priceVersion: price.priceVersion,
      worstCasePerCallCents: price.worstCaseCents, maxCalls: 1,
      maxWorstCaseCents: price.worstCaseCents, eligibleJobCount: 1,
      jobSnapshotHash: personSourceJobSnapshot([{
        ...jobs[12], status: "QUEUED",
      }]), status: "RUNNING", expiresAt: future(),
    } });
  }
  await db.researchFullRun.create({ data: {
    ...scope, provider: "gemini", model: "gemini-3-flash-preview",
    priceVersion: price.priceVersion, targetQualifiedContacts: 100,
    maxDiscoveryCalls: 10, maxSourceCalls: 15,
    maxEmailInspectionPages: 100, maxDiscoveryWorstCaseCents: 500,
    maxSourceWorstCaseCents: 15 * price.worstCaseCents,
    maxTotalWorstCaseCents: 500 + 15 * price.worstCaseCents,
    publicInspectionAuthorized: true, status: "SOURCE_RUNNING",
    expiresAt: future(),
  } });
  return scope;
}

test("real PostgreSQL: a quality stop is durable, one-use and fences initial paid claim", {
  skip: !integration,
}, async () => {
  const db = new PrismaClient();
  try {
    const scope = await fixture(db);
    const [a, b] = await Promise.all([
      stopFullRunSourceOnZeroYield(db, scope),
      stopFullRunSourceOnZeroYield(db, scope),
    ]);
    assert.deepEqual([a.status, b.status].sort(), ["PARTIAL", "UNCHANGED"]);
    const [full, approval, events, jobs] = await Promise.all([
      db.researchFullRun.findUnique({ where: { campaignId: scope.campaignId } }),
      db.researchPersonSourceApproval.findUnique({ where: { campaignId: scope.campaignId } }),
      db.auditEvent.count({ where: {
        entityId: scope.campaignId, action: "research.full-run.zero-yield.stopped",
      } }),
      db.researchPersonSourceJob.findMany({ where: { campaignId: scope.campaignId } }),
    ]);
    assert.equal(full.status, "PARTIAL");
    assert.equal(full.lastCode, "SOURCE_ZERO_YIELD_EARLY_STOP");
    assert.equal(approval.status, "QUALITY_STOP");
    assert.equal(events, 1);
    assert.equal(jobs.filter(job => job.status === "QUEUED").length, 1);
    const blocked = await claimPersonSourceJob(db, {
      ...scope, provider: "gemini", model: "gemini-3-flash-preview",
    });
    assert.equal(blocked.code, "PERSON_SOURCE_APPROVAL_REQUIRED");
    assert.equal(await db.auditEvent.count({ where: {
      entityId: scope.campaignId,
      action: "research.person-source.spend.reserved",
    } }), 0);
  } finally { await db.$disconnect(); }
});

test("real PostgreSQL: continuation claim and future cycle creation are fenced", {
  skip: !integration,
}, async () => {
  const db = new PrismaClient();
  try {
    const scope = await fixture(db, { futureCycle: true });
    const result = await stopFullRunSourceOnZeroYield(db, scope);
    assert.equal(result.status, "PARTIAL");
    const cycle = await db.researchPersonSourceCycle.findFirst({
      where: { campaignId: scope.campaignId },
    });
    assert.equal(cycle.status, "QUALITY_STOP");
    const claim = await claimPersonSourceJob(db, {
      ...scope, provider: "gemini", model: "gemini-3-flash-preview",
    });
    assert.equal(claim.code, "PERSON_SOURCE_APPROVAL_REQUIRED");
    const continuation = await createNextSourceCycle(db, scope);
    assert.equal(continuation.code, "SOURCE_CONTINUATION_NOT_AUTHORIZED");
  } finally { await db.$disconnect(); }
});

test("real PostgreSQL: no live eligible person source never triggers cost-saving stop", {
  skip: !integration,
}, async () => {
  const db = new PrismaClient();
  try {
    const scope = await fixture(db, { invalidQueued: true });
    const result = await stopFullRunSourceOnZeroYield(db, scope);
    assert.equal(result.code, "NO_CURRENTLY_ELIGIBLE_SOURCE_JOBS");
    const full = await db.researchFullRun.findUnique({
      where: { campaignId: scope.campaignId },
    });
    assert.equal(full.status, "SOURCE_RUNNING");
  } finally { await db.$disconnect(); }
});

test("real PostgreSQL: concurrent claim waits for committed QUALITY_STOP", {
  skip: !integration,
}, async () => {
  const db = new PrismaClient();
  const claimant = new PrismaClient();
  try {
    const scope = await fixture(db);
    let markStopped;
    let permitCommit;
    const stoppedInTransaction = new Promise(resolve => { markStopped = resolve; });
    const commitGate = new Promise(resolve => { permitCommit = resolve; });
    // Use an actual PostgreSQL transaction, holding its campaign lock and
    // QUALITY_STOP writes before commit. The claimant uses a distinct pool.
    const stop = db.$transaction(async tx => {
      const result = await stopFullRunSourceOnZeroYield({
        $transaction: async callback => callback(tx),
      }, scope);
      assert.equal(result.status, "PARTIAL");
      markStopped();
      await commitGate;
      return result;
    }, { timeout: 15_000 });
    await stoppedInTransaction;
    const claim = claimPersonSourceJob(claimant, {
      ...scope, provider: "gemini", model: "gemini-3-flash-preview",
    });
    // Both operations now overlap while the stop's lock is still held.
    permitCommit();
    assert.equal((await stop).code, "SOURCE_ZERO_YIELD_EARLY_STOP");
    assert.equal((await claim).code, "PERSON_SOURCE_APPROVAL_REQUIRED");
    assert.equal(await db.researchSpendReservation.count({
      where: { ownerId: scope.ownerId },
    }), 0);
    assert.equal(await db.researchPersonSourceJob.count({
      where: { campaignId: scope.campaignId, status: "RUNNING" },
    }), 0);
  } finally {
    await claimant.$disconnect();
    await db.$disconnect();
  }
});
