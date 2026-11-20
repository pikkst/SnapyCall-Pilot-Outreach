import test from "node:test";
import assert from "node:assert/strict";
import { claimPersonSourceJob, proposedPersonSource, personSourceSearchQuery,
  selectNextPersonSourceJob, PersonSourceExecutionBlocked }
  from "../server/research-person-source-executor.js";
import { personSourceFingerprint } from "../server/research-person-source-queue.js";
import { personSourceJobSnapshot } from "../server/research-person-source-approval.js";
import { requireResearchPriceEnvelope } from "../server/research-price-policy.js";

const scope = {
  campaignId: "cmabcdefghijklmnopqrstu",
  workspaceId: "cmabcdefghijklmnopqrstv",
  ownerId: "cmabcdefghijklmnopqrstw",
  provider: "openai", model: "gpt-4.1-mini",
};
const clock = new Date("2026-11-18T14:30:00Z");
const evidence = {
  id: "cmabcdefghijklmnopqrs1", name: "Ada Lovelace",
  category: "AI_AUTOMATION", citationUrl: "https://example.org/team",
  groundingStatus: "UNCHECKED", groundingResolvedUrl: null,
  groundingProvenance: null, emailTriageStatus: "BLOCKED",
};
const sourceJob = {
  id: "cmabcdefghijklmnopqrs2",
  campaignId: scope.campaignId, observationId: evidence.id,
  evidenceFingerprint: personSourceFingerprint(evidence),
  reason: "SHARED_SOURCE", status: "QUEUED", attempts: 0,
  leaseToken: null, leaseUntil: null,
};
const price = requireResearchPriceEnvelope({
  provider: scope.provider, model: scope.model,
});

function fixture({ member = true, campaignStatus = "PARTIAL",
  changedEvidence = false, approved = true, mismatchedModel = false,
  priorRunning = false, continuation = false,
  fullStopped = false } = {}) {
  const events = [];
  const job = { ...sourceJob,
    cycleIndex: continuation ? 1 : 0,
    ...(priorRunning ? {
    status: "RUNNING", leaseToken: "old", attempts: 1,
  } : {}) };
  const approval = {
    id: "cmabcdefghijklmnopqrs3", campaignId: scope.campaignId,
    workspaceId: scope.workspaceId, ownerId: scope.ownerId,
    provider: scope.provider, model: mismatchedModel ? "other" : scope.model,
    priceVersion: price.priceVersion,
    worstCasePerCallCents: price.worstCaseCents,
    maxCalls: 1, maxWorstCaseCents: price.worstCaseCents,
    eligibleJobCount: 1, jobSnapshotHash: personSourceJobSnapshot([sourceJob]),
    status: continuation ? "PARTIAL_BUDGET" : "APPROVED",
    startedCalls: 0, committedWorstCaseCents: 0,
    expiresAt: new Date("2026-11-19T12:00:00Z"),
  };
  const cycle = { ...approval, id: "cmabcdefghijklmnopqrs4",
    status: "APPROVED", cycleIndex: 1,
    startedCalls: 0, committedWorstCaseCents: 0 };
  const currentEvidence = changedEvidence
    ? { ...evidence, name: "Another Person" } : evidence;
  const reservations = new Map();
  const tx = {
    $queryRaw: async chunks => {
      const sql = chunks.join("?");
      if (sql.includes('FROM "PartnerMembership"'))
        return member ? [{ revokedAt: null }] : [];
      if (sql.includes('FROM "ResearchCampaign"'))
        return [{ id: scope.campaignId, status: campaignStatus }];
      if (sql.includes('FROM "ResearchUserLimits"'))
        return [{ dailyLimit: 50, maxCandidates: 10, maxConcurrent: 1 }];
      if (sql.includes('FROM "Partner"'))
        return [{ id: scope.workspaceId }];
      if (sql.includes('FROM "ResearchRunLease"') &&
          sql.includes('AS "waitMs"')) return [];
      if (sql.includes('FROM "ResearchRunLease"'))
        return [{ workspace: 0, user: 0 }];
      if (sql.includes('FROM "ResearchOwnerBudget"'))
        return sql.includes('"monthlyLimitCents"')
          ? [{ monthlyLimitCents: 50000 }] : [{ ownerId: scope.ownerId }];
      if (sql.includes('INSERT INTO "ResearchDailyQuota"')) {
        events.push("quota"); return [{ attempts: 1 }];
      }
      throw new Error("Unexpected SQL: " + sql);
    },
    $executeRaw: async () => { events.push("concurrency"); return 1; },
    researchPersonSourceApproval: {
      findUnique: async () => approved ? approval : null,
      updateMany: async ({ data, where }) => {
        // A cycle ID must never write to the original approval table.
        assert.equal(where.id, approval.id);
        events.push("original-approval-counter");
        approval.startedCalls += data.startedCalls.increment;
        approval.committedWorstCaseCents +=
          data.committedWorstCaseCents.increment;
        approval.status = data.status;
        return { count: 1 };
      },
    },
    researchFullRun: {
      findUnique: async () => ({
        ...scope, status: fullStopped ? "STOPPED" : "SOURCE_RUNNING",
        expiresAt: new Date("2026-11-19T12:00:00Z"),
      }),
    },
    researchPersonSourceCycle: {
      findFirst: async () => continuation ? cycle : null,
      count: async () => 0,
      updateMany: async ({ data, where }) => {
        assert.equal(where.id, cycle.id);
        assert.equal(where.cycleIndex, 1);
        events.push("cycle-counter");
        cycle.startedCalls += data.startedCalls.increment;
        cycle.committedWorstCaseCents += data.committedWorstCaseCents.increment;
        cycle.status = data.status;
        return { count: 1 };
      },
    },
    researchPersonSourceJob: {
      findMany: async () => [job],
      count: async () => 0,
      updateMany: async ({ data }) => {
        events.push("job-claimed");
        Object.assign(job, data, { attempts: job.attempts + 1 });
        return { count: 1 };
      },
    },
    researchCampaignObservation: {
      findFirst: async () => currentEvidence,
    },
    researchSpendReservation: {
      findUnique: async ({ where }) => reservations.get(where.id) ?? null,
      create: async ({ data }) => {
        events.push("spend-reserved");
        reservations.set(data.id, data);
      },
    },
    // No historical exclusions exist in this clean fixture.
    partner: {
      findUnique: async () => ({ researchDailyLimit: 1000 }),
    },
    researchSpendAdjustment: {
      aggregate: async () => ({ _sum: { excludedCents: null } }),
    },
    researchSpendMonth: {
      upsert: async () => ({ reservedCents: 0, settledCents: 0 }),
      update: async () => { events.push("spend-ledger"); },
    },
    auditEvent: { create: async ({ data }) => {
      events.push("audit");
      assert.equal(data.metadata.automaticBillableReplay, false);
      assert.equal(data.metadata.sendingEnabled, false);
      assert.equal(JSON.stringify(data.metadata).includes("Ada"), false);
    } },
  };
  return { db: { $transaction: async fn => fn(tx) },
    events, job, approval, cycle, reservations };
}

test("atomically claims one job after tenant, spend and daily quota reservations", async () => {
  const state = fixture();
  const claim = await claimPersonSourceJob(state.db, scope, { now: clock });
  assert.equal(claim.status, "CLAIMED");
  assert.equal(claim.observationId, evidence.id);
  assert.equal(claim.worstCaseCents, price.worstCaseCents);
  assert.equal(claim.query.includes("Ada Lovelace"), true);
  assert.match(claim.reservationId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(state.events, [
    "concurrency", "spend-reserved", "spend-ledger", "quota", "quota",
    "original-approval-counter", "job-claimed", "audit",
  ]);
  assert.equal(state.job.status, "RUNNING");
  assert.equal(state.approval.startedCalls, 1);
  assert.equal(state.reservations.size, 1);
  const replay = await claimPersonSourceJob(state.db, scope, { now: clock });
  assert.equal(replay.code, "SOURCE_JOB_UNSETTLED");
  assert.equal(state.reservations.size, 1);
});

test("auth, model, budget and changed identity fail before monetary reservation", async () => {
  for (const [opts, expected] of [
    [{ member: false }, "WORKSPACE_ACCESS_REVOKED"],
    [{ campaignStatus: "RUNNING" }, "DISCOVERY_NOT_TERMINAL"],
    [{ approved: false }, "PERSON_SOURCE_APPROVAL_REQUIRED"],
    [{ mismatchedModel: true }, "PERSON_SOURCE_PRICE_CHANGED"],
    [{ changedEvidence: true }, "SOURCE_JOB_EVIDENCE_CHANGED"],
    [{ priorRunning: true }, "SOURCE_JOB_UNSETTLED"],
  ]) {
    const state = fixture(opts);
    const result = await claimPersonSourceJob(state.db, scope, { now: clock });
    assert.equal(result.code, expected);
    assert.deepEqual(state.events, []);
  }
});

test("person-source proposal is a single exact person cited URL, never an email", () => {
  const person = (name, sourceUrl) => ({
    name, category: "AI_AUTOMATION", sourceUrl,
    rationale: "Public biography with relevant qualifications",
  });
  const a = "https://example.org/ada";
  const b = "https://example.org/another";
  const source = candidate => ({ candidates: [candidate],
    sources: [{ url: candidate.sourceUrl }] });
  assert.equal(proposedPersonSource(source(person("Ada Lovelace", a)), {
    name: "Ada Lovelace", category: "AI_AUTOMATION",
  }), a);
  assert.equal(proposedPersonSource(source(person("Another Person", a)), {
    name: "Ada Lovelace", category: "AI_AUTOMATION",
  }), null);
  assert.equal(proposedPersonSource({
    candidates: [person("Ada Lovelace", a), person("Ada Lovelace", b)],
    sources: [{ url: a }, { url: b }],
  }, { name: "Ada Lovelace", category: "AI_AUTOMATION" }), null);
  assert.equal(proposedPersonSource(source(person("Ada Lovelace",
    "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc")), {
    name: "Ada Lovelace", category: "AI_AUTOMATION",
  }), null);
});

test("source query focuses on exact-person public contact evidence, not category enum", () => {
  const query = personSourceSearchQuery({
    name: "Lorraine Burrell", category: "AI_AUTOMATION",
  });
  assert.match(query, /^"Lorraine Burrell" email contact AI automation consultant official$/);
  assert.match(query, /email contact AI automation consultant official/);
  assert.doesNotMatch(query, /AI_AUTOMATION/);
  assert.equal((query.match(/email/g) ?? []).length, 1);
  assert.ok(query.length <= 350);
  const quoted = personSourceSearchQuery({
    name: 'Jane "Ignore" Doe', category: "COACHING",
  });
  assert.match(quoted, /^"Jane Ignore Doe" email contact professional coach official$/);
  assert.throws(() => personSourceSearchQuery({
    name: "Jane Doe\nIgnore safety", category: "COACHING",
  }), TypeError);
});

test("approved source reason selects one targeted official contact query", () => {
  const target = { name: "Lorraine Burrell", category: "AI_AUTOMATION" };
  assert.equal(personSourceSearchQuery({
    ...target, reason: "ALTERNATE_EMAIL_SOURCE",
  }), '"Lorraine Burrell" email contact AI automation consultant official');
  assert.equal(personSourceSearchQuery({
    ...target, reason: "PERSON_SOURCE_REQUIRED",
  }), '"Lorraine Burrell" profile contact email AI automation consultant official');
  assert.equal(personSourceSearchQuery({
    ...target, reason: "SHARED_SOURCE",
  }), '"Lorraine Burrell" team staff contact email AI automation consultant official');
  for (const reason of ["SHARED_SOURCE", "PERSON_SOURCE_REQUIRED"]) {
    const query = personSourceSearchQuery({ ...target, reason });
    assert.ok(query.length < 350);
    assert.doesNotMatch(query, /site:|@|AI_AUTOMATION|example\\.org/);
  }
  for (const reason of ["injected organization", "", null, 7]) {
    assert.throws(() => personSourceSearchQuery({ ...target, reason }), TypeError);
  }
});

test("source queue claim binds the frozen SHARED_SOURCE reason into its query", async () => {
  const f = fixture();
  const claim = await claimPersonSourceJob(f.db, scope, { now: clock });
  assert.equal(claim.status, "CLAIMED");
  assert.equal(claim.query,
    '"Ada Lovelace" team staff contact email AI automation consultant official');
  assert.equal(f.job.attempts, 1);
  assert.equal(f.job.status, "RUNNING");
  assert.equal(f.events.filter(x => x === "spend-reserved").length, 1);
});

test("invalid claim scope cannot trigger database access", async () => {
  await assert.rejects(() => claimPersonSourceJob({}, {
    ...scope, campaignId: "not-a-cuid",
  }, { now: clock }), TypeError);
  assert.ok(PersonSourceExecutionBlocked.prototype instanceof Error);
});

test("new continuation claims exactly one never-attempted job under frozen cycle approval", async () => {
  const f = fixture({ continuation: true });
  const claim = await claimPersonSourceJob(f.db, scope, { now: clock });
  assert.equal(claim.status, "CLAIMED");
  assert.equal(f.job.cycleIndex, 1);
  assert.equal(f.job.attempts, 1);
  assert.equal(f.reservations.size, 1);
  assert.equal(f.events.filter(x => x === "cycle-counter").length, 1);
  assert.equal(f.events.filter(x => x === "original-approval-counter").length, 0);
  assert.equal(f.cycle.startedCalls, 1);
  assert.equal(f.cycle.committedWorstCaseCents, price.worstCaseCents);
  assert.equal(f.approval.startedCalls, 0);
  assert.equal(f.events.filter(x => x === "spend-reserved").length, 1);
  const replay = await claimPersonSourceJob(f.db, scope, { now: clock });
  assert.equal(replay.code, "SOURCE_JOB_UNSETTLED");
  assert.equal(f.reservations.size, 1);
});

test("stopped full-run prevents any new continuation charge", async () => {
  const f = fixture({ continuation: true, fullStopped: true });
  const result = await claimPersonSourceJob(f.db, scope, { now: clock });
  assert.equal(result.code, "SOURCE_CONTINUATION_NOT_ACTIVE");
  assert.deepEqual(f.events, []);
});

test("source queue prioritizes previously inspectable person sources over shared directory citations", () => {
  const make = (observationId, reason, status = "QUEUED", attempts = 0) =>
    ({ observationId, reason, status, attempts });
  const jobs = [
    make("c000000000000000000000010", "SHARED_SOURCE"),
    make("c000000000000000000000020", "PERSON_SOURCE_REQUIRED"),
    make("c000000000000000000000030", "ALTERNATE_EMAIL_SOURCE"),
    make("c000000000000000000000040", "SHARED_SOURCE"),
    make("c000000000000000000000005", "ALTERNATE_EMAIL_SOURCE",
      "SOURCE_UNAVAILABLE", 1),
  ];
  assert.equal(selectNextPersonSourceJob(jobs).observationId,
    "c000000000000000000000030");
  jobs[2].attempts = 1;
  assert.equal(selectNextPersonSourceJob(jobs).observationId,
    "c000000000000000000000020");
  jobs[1].status = "SOURCE_UNAVAILABLE";
  assert.equal(selectNextPersonSourceJob(jobs).observationId,
    "c000000000000000000000010");
  assert.deepEqual(jobs.map(x => x.reason), [
    "SHARED_SOURCE", "PERSON_SOURCE_REQUIRED", "ALTERNATE_EMAIL_SOURCE",
    "SHARED_SOURCE", "ALTERNATE_EMAIL_SOURCE",
  ], "selection must not mutate the immutable snapshot order");
});

test("source queue excludes billed attempts, preserves stable ordering, and fails closed on invalid size", () => {
  const a = { observationId: "ca", status: "QUEUED",
    reason: "SHARED_SOURCE", attempts: 0 };
  const b = { observationId: "cb", status: "QUEUED",
    reason: "SHARED_SOURCE", attempts: 1 };
  const c = { observationId: "cc", status: "QUEUED",
    reason: "SHARED_SOURCE", attempts: 0 };
  assert.equal(selectNextPersonSourceJob([c, a, b]), a);
  assert.equal(selectNextPersonSourceJob([b]), null);
  assert.equal(selectNextPersonSourceJob([]), null);
  assert.throws(() => selectNextPersonSourceJob(Array(251).fill(a)),
    TypeError);
});

test("campaign-local zero-yield source reasons defer to untried next tier", () => {
  const job = (reason, id, status = "QUEUED", attempts = 0) => ({
    id, observationId: id, reason, status, attempts,
  });
  const jobs = [
    job("ALTERNATE_EMAIL_SOURCE", "c100"),
    job("PERSON_SOURCE_REQUIRED", "c200"),
    ...Array.from({ length: 4 }, (_, i) =>
      job("ALTERNATE_EMAIL_SOURCE", "c3" + i, "COMPLETED", 1)),
  ];
  assert.equal(selectNextPersonSourceJob(jobs).observationId, "c200");
  assert.deepEqual(jobs[0], job("ALTERNATE_EMAIL_SOURCE", "c100"),
    "selection must not mutate queued or approved job metadata");
});

test("verified person-email yield can promote a reason over the default tier", () => {
  const job = (reason, id, status = "QUEUED", attempts = 0) => ({
    id, observationId: id, reason, status, attempts,
  });
  const jobs = [
    job("ALTERNATE_EMAIL_SOURCE", "c100"),
    job("PERSON_SOURCE_REQUIRED", "c200"),
    ...Array.from({ length: 2 }, (_, i) =>
      job("PERSON_SOURCE_REQUIRED", "c3" + i, "VERIFIED", 1)),
    ...Array.from({ length: 2 }, (_, i) =>
      job("PERSON_SOURCE_REQUIRED", "c4" + i, "COMPLETED", 1)),
  ];
  assert.equal(selectNextPersonSourceJob(jobs).observationId, "c200");
});

test("small samples, incomplete tasks and merely completed calls never imply yield", () => {
  const job = (reason, id, status = "QUEUED", attempts = 0) => ({
    id, observationId: id, reason, status, attempts,
  });
  const jobs = [
    job("ALTERNATE_EMAIL_SOURCE", "c100"),
    job("PERSON_SOURCE_REQUIRED", "c200"),
    ...Array.from({ length: 3 }, (_, i) =>
      job("ALTERNATE_EMAIL_SOURCE", "c3" + i, "COMPLETED", 1)),
    job("ALTERNATE_EMAIL_SOURCE", "c400", "PAUSED", 1),
    job("ALTERNATE_EMAIL_SOURCE", "c401", "RUNNING", 1),
  ];
  assert.equal(selectNextPersonSourceJob(jobs).observationId, "c100");
  jobs.push(job("ALTERNATE_EMAIL_SOURCE", "c500", "VERIFIED", 1));
  assert.equal(selectNextPersonSourceJob(jobs).observationId, "c100",
    "one verified email does not justify a promotion");
});

test("reason feedback remains scoped to supplied jobs; stable tie break and no retries", () => {
  const jobs = [
    { reason: "SHARED_SOURCE", observationId: "c900",
      status: "QUEUED", attempts: 0 },
    { reason: "SHARED_SOURCE", observationId: "c800",
      status: "QUEUED", attempts: 0 },
    { reason: "SHARED_SOURCE", observationId: "c700",
      status: "VERIFIED", attempts: 1 },
  ];
  assert.equal(selectNextPersonSourceJob(jobs).observationId, "c800");
  assert.equal(selectNextPersonSourceJob(jobs.slice(0, 2)).observationId, "c800");
  assert.equal(selectNextPersonSourceJob(jobs.slice(2)), null);
});

test("campaign-local access failures deprioritize a source reason without stopping approved jobs", () => {
  const queued = (id, reason) => ({ observationId: id, reason,
    status: "QUEUED", attempts: 0 });
  const settled = (id, code) => ({
    observationId: id, reason: "ALTERNATE_EMAIL_SOURCE",
    status: "COMPLETED", attempts: 1, lastErrorCode: code,
  });
  const base = [
    queued("a-first", "ALTERNATE_EMAIL_SOURCE"),
    queued("b-shared", "SHARED_SOURCE"),
  ];
  const readable = [...base, ...Array.from({ length: 4 }, (_, index) =>
    settled("c-" + index, "SOURCE_NO_NAMED_EMAIL_EVIDENCE"))];
  assert.equal(selectNextPersonSourceJob(readable).observationId, "a-first",
    "readable without email must not be classified as an access denial");
  const denied = [...base, ...Array.from({ length: 3 }, (_, index) =>
    settled("c-" + index, "SOURCE_ALL_PAGES_UNAVAILABLE")),
  settled("c-3", "SOURCE_NO_NAMED_EMAIL_EVIDENCE")];
  assert.equal(selectNextPersonSourceJob(denied).observationId, "a-first",
    "equal ranking preserves the existing deterministic observation-ID tie");
  const reversedIds = denied.map(job => job.observationId === "a-first"
    ? { ...job, observationId: "z-alternate" } : job);
  assert.equal(selectNextPersonSourceJob(reversedIds).observationId, "b-shared",
    "known inaccessible outcomes can move next eligible reason ahead");
  assert.equal(reversedIds.filter(job => job.status === "QUEUED").length, 2,
    "priority adjustments must not cancel or remove authorized work");
});

test("source access signal requires settled, documented failures and minimum sample", () => {
  const pending = [
    { observationId: "z-alt", reason: "ALTERNATE_EMAIL_SOURCE",
      status: "QUEUED", attempts: 0 },
    { observationId: "a-shared", reason: "SHARED_SOURCE",
      status: "QUEUED", attempts: 0 },
  ];
  const failures = Array.from({ length: 4 }, (_, i) => ({
    observationId: "failed-" + i, reason: "ALTERNATE_EMAIL_SOURCE",
    status: "COMPLETED", attempts: 1,
    lastErrorCode: "SOURCE_ALL_PAGES_UNAVAILABLE",
  }));
  assert.equal(selectNextPersonSourceJob([...pending, ...failures.slice(0, 3)])
    .observationId, "z-alt", "three settled jobs are insufficient");
  const uncertain = { ...failures[3], status: "PAUSED" };
  assert.equal(selectNextPersonSourceJob([...pending, ...failures.slice(0, 3), uncertain])
    .observationId, "z-alt", "potentially billed unsettled work is excluded");
  const mixed = [
    failures[0], failures[1],
    { ...failures[2], lastErrorCode: "SOURCE_NO_NAMED_EMAIL_EVIDENCE" },
    { ...failures[3], lastErrorCode: "BILLING_UNCERTAIN" },
  ];
  assert.equal(selectNextPersonSourceJob([...pending, ...mixed])
    .observationId, "z-alt", "two of four inaccessible results do not reach threshold");
  assert.equal(selectNextPersonSourceJob([...pending, ...failures])
    .observationId, "a-shared", "four confirmed failures justify a limited demotion");
});
