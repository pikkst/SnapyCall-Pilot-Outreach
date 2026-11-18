import test from "node:test";
import assert from "node:assert/strict";
import { createNextSourceCycle, finalizeSourceCycle, SOURCE_CYCLE_SIZE }
  from "../server/research-person-source-cycles.js";
import { personSourceFingerprint } from "../server/research-person-source-queue.js";
import { personSourceJobSnapshot } from "../server/research-person-source-approval.js";
import { requireResearchPriceEnvelope } from "../server/research-price-policy.js";

const scope = {
  campaignId: "cmabcdefghijklmnopqrstu",
  workspaceId: "cmabcdefghijklmnopqrstv",
  ownerId: "cmabcdefghijklmnopqrstw",
};
const clock = new Date("2026-11-18T16:20:00Z");
const price = requireResearchPriceEnvelope({
  provider: "gemini", model: "gemini-3-flash-preview",
});
const original = i => ({
  id: "cmabcdefghijklmnopqrs" + String(i + 100),
  name: "Expert Person " + i, category: "AI_AUTOMATION",
  citationUrl: "https://example.org/team",
  groundingStatus: "UNCHECKED", groundingResolvedUrl: null,
  groundingProvenance: null, emailTriageStatus: "BLOCKED",
});
function fixture({ remaining = 60, usedFirst = 25, sourceLimit = 100,
  oldCycles = [], member = true, fullStatus = "SOURCE_RUNNING",
  uncertain = false, expires = false, providerModel = "gemini-3-flash-preview",
} = {}) {
  const events = [];
  const observations = Array.from({ length: remaining + usedFirst }, (_, i) => original(i));
  const jobs = observations.map((row, i) => ({
    id: "cmabcdefghijklmno" + String(i + 100).padStart(8, "0"),
    campaignId: scope.campaignId, observationId: row.id,
    evidenceFingerprint: personSourceFingerprint(row),
    reason: "PERSON_SOURCE_REQUIRED",
    status: i < usedFirst ? "VERIFIED" : "QUEUED",
    cycleIndex: 0, attempts: i < usedFirst ? 1 : 0,
    spendReservationId: i < usedFirst ? "old-reservation" : null,
    proposedSourceUrl: null,
  }));
  if (uncertain) jobs[0].status = "PAUSED";
  const cycles = [...oldCycles];
  const first = {
    ...scope, status: "PARTIAL_BUDGET", provider: "gemini",
    model: "gemini-3-flash-preview", priceVersion: price.priceVersion,
    worstCasePerCallCents: price.worstCaseCents,
    startedCalls: usedFirst,
    committedWorstCaseCents: usedFirst * price.worstCaseCents,
  };
  const full = {
    ...scope, status: fullStatus, provider: "gemini",
    model: "gemini-3-flash-preview", priceVersion: price.priceVersion,
    maxSourceCalls: sourceLimit,
    maxSourceWorstCaseCents: sourceLimit * price.worstCaseCents,
    expiresAt: new Date(clock.getTime() + (expires ? -1 : 100000)),
  };
  const tx = {
    $queryRaw: async fragments => {
      const sql = fragments.join("?");
      if (sql.includes('FROM "PartnerMembership"'))
        return member ? [{ revokedAt: null }] : [];
      if (sql.includes('FROM "ResearchCampaign"'))
        return [{ id: scope.campaignId, status: "PARTIAL" }];
      throw new Error("Unexpected SQL " + sql);
    },
    researchFullRun: { findUnique: async () => full },
    researchPersonSourceApproval: { findUnique: async () => first },
    researchPersonSourceCycle: {
      findMany: async () => cycles,
      findFirst: async () => cycles.findLast(x =>
        ["APPROVED", "RUNNING"].includes(x.status)) ?? null,
      create: async ({ data }) => {
        events.push("cycle-created");
        const c = { id: "cmcycle123456789101112", ...data, status: "APPROVED",
          startedCalls: 0, committedWorstCaseCents: 0 };
        cycles.push(c); return c;
      },
      updateMany: async ({ data }) => {
        events.push("cycle-terminal");
        cycles.at(-1).status = data.status;
        return { count: 1 };
      },
    },
    aiSetting: { findUnique: async () => ({
      provider: "gemini", model: providerModel,
    }) },
    researchCampaignObservation: {
      findMany: async ({ where }) => observations.filter(row =>
        where.id.in.includes(row.id)),
    },
    researchPersonSourceJob: {
      count: async ({ where }) =>
        where.status?.in?.includes("PAUSED") && uncertain ? 1 : 0,
      findMany: async ({ where, take }) => jobs.filter(job => {
        if (where.cycleIndex !== undefined &&
            job.cycleIndex !== where.cycleIndex) return false;
        if (where.status === "QUEUED" && job.status !== "QUEUED") return false;
        if (where.attempts === 0 && job.attempts !== 0) return false;
        if (where.spendReservationId === null &&
            job.spendReservationId !== null) return false;
        return true;
      }).slice(0, take),
      updateMany: async ({ where, data }) => {
        const row = jobs.find(job => job.id === where.id &&
          job.status === where.status && job.cycleIndex === where.cycleIndex);
        if (!row) return { count: 0 };
        Object.assign(row, data); events.push("job-assigned");
        return { count: 1 };
      },
    },
    auditEvent: { create: async ({ data }) => {
      events.push("audit");
      assert.equal(data.metadata.automaticBillableReplay, false);
      assert.equal(data.metadata.sendingEnabled, false);
    } },
  };
  return { db: { $transaction: fn => fn(tx) }, tx, events,
    jobs, cycles, full, first };
}

test("first continuation freezes only the next 25 never-attempted jobs", async () => {
  const f = fixture();
  const result = await createNextSourceCycle(f.db, scope, { now: clock });
  assert.equal(result.status, "CREATED");
  assert.equal(result.cycleIndex, 1);
  assert.equal(result.count, SOURCE_CYCLE_SIZE);
  assert.equal(f.cycles.length, 1);
  assert.equal(f.cycles[0].startedCalls, 0);
  assert.equal(f.cycles[0].maxWorstCaseCents,
    SOURCE_CYCLE_SIZE * price.worstCaseCents);
  assert.equal(f.jobs.filter(job => job.cycleIndex === 1).length, SOURCE_CYCLE_SIZE);
  assert.equal(f.jobs.slice(0, 25).every(job => job.status === "VERIFIED"), true);
  assert.equal(personSourceJobSnapshot(f.jobs.filter(job => job.cycleIndex === 1)),
    f.cycles[0].jobSnapshotHash);
});

test("active cycle prevents duplicate authorization during worker restart", async () => {
  const f = fixture();
  await createNextSourceCycle(f.db, scope, { now: clock });
  const repeat = await createNextSourceCycle(f.db, scope, { now: clock });
  assert.equal(repeat.status, "WAITING");
  assert.equal(f.cycles.length, 1);
  assert.equal(f.jobs.filter(job => job.cycleIndex === 1).length, 25);
});

test("new cycles use monotonically remaining approval, not renewed initial quota", async () => {
  const f = fixture({ remaining: 60, sourceLimit: 35 });
  const first = await createNextSourceCycle(f.db, scope, { now: clock });
  assert.equal(first.count, 10);
  // Simulate all ten prior calls settled and the immutable cycle closed.
  f.cycles[0].startedCalls = 10;
  f.cycles[0].committedWorstCaseCents = 10 * price.worstCaseCents;
  f.cycles[0].status = "COMPLETED";
  f.jobs.filter(job => job.cycleIndex === 1).forEach(job => {
    job.status = "VERIFIED"; job.attempts = 1;
  });
  const next = await createNextSourceCycle(f.db, scope, { now: clock });
  assert.equal(next.status, "EXHAUSTED");
  assert.equal(next.code, "SOURCE_CONTINUATION_BUDGET_EXHAUSTED");
  assert.equal(f.cycles.length, 1);
});

test("unsettled, revoked, expired and provider-drift campaigns cannot authorize continuation", async () => {
  for (const [options, code] of [
    [{ uncertain: true }, "SOURCE_JOB_UNSETTLED"],
    [{ member: false }, "WORKSPACE_ACCESS_REVOKED"],
    [{ expires: true }, "SOURCE_CONTINUATION_NOT_AUTHORIZED"],
    [{ fullStatus: "STOPPED" }, "SOURCE_CONTINUATION_NOT_AUTHORIZED"],
    [{ providerModel: "gpt-4.1-mini" }, "APPROVED_PROVIDER_CHANGED"],
  ]) {
    const f = fixture(options);
    const result = await createNextSourceCycle(f.db, scope, { now: clock });
    assert.equal(result.code, code);
    assert.equal(f.cycles.length, 0);
    assert.equal(f.jobs.some(job => job.cycleIndex > 0), false);
  }
});

test("terminal cycle is fenced; no replay after paid or public inspection uncertainty", async () => {
  const f = fixture();
  await createNextSourceCycle(f.db, scope, { now: clock });
  f.cycles[0].startedCalls = 25;
  f.cycles[0].committedWorstCaseCents = 25 * price.worstCaseCents;
  f.cycles[0].status = "RUNNING";
  f.jobs.filter(job => job.cycleIndex === 1).forEach(job => {
    job.status = "VERIFIED"; job.attempts = 1;
  });
  const done = await finalizeSourceCycle(f.db, scope);
  assert.equal(done.status, "COMPLETED");
  assert.equal(f.cycles[0].status, "COMPLETED");
  const replay = await finalizeSourceCycle(f.db, scope);
  assert.equal(replay.status, "IDLE");
});

test("100 synthetic continuation jobs span four unique cycles without new paid permission", async () => {
  const f = fixture({ remaining: 100, usedFirst: 25, sourceLimit: 125 });
  const billedObservationIds = new Set(f.jobs.filter(job =>
    job.attempts === 1).map(job => job.observationId));
  for (let cycle = 1; cycle <= 4; cycle++) {
    const created = await createNextSourceCycle(f.db, scope, { now: clock });
    assert.equal(created.status, "CREATED");
    assert.equal(created.cycleIndex, cycle);
    assert.equal(created.count, 25);
    const claimed = f.jobs.filter(job => job.cycleIndex === cycle);
    assert.equal(claimed.length, 25);
    for (const job of claimed) {
      assert.equal(job.status, "QUEUED");
      assert.equal(job.attempts, 0);
      assert.equal(billedObservationIds.has(job.observationId), false);
      billedObservationIds.add(job.observationId);
      job.status = "VERIFIED";
      job.attempts = 1;
    }
    f.cycles.at(-1).status = "RUNNING";
    f.cycles.at(-1).startedCalls = 25;
    f.cycles.at(-1).committedWorstCaseCents = 25 * price.worstCaseCents;
    const finished = await finalizeSourceCycle(f.db, scope);
    assert.equal(finished.status, "COMPLETED");
  }
  assert.equal(billedObservationIds.size, 125);
  assert.equal(f.cycles.length, 4);
  assert.equal(f.first.startedCalls + f.cycles.reduce((sum, c) =>
    sum + c.startedCalls, 0), 125);
  const exhausted = await createNextSourceCycle(f.db, scope, { now: clock });
  assert.equal(exhausted.status, "EXHAUSTED");
  assert.equal(exhausted.code, "SOURCE_CONTINUATION_BUDGET_EXHAUSTED");
  assert.equal(f.jobs.some(job => job.status === "QUEUED"), false);
});
