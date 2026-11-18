import test from "node:test";
import assert from "node:assert/strict";
import { approvePersonSourceResearch, personSourceJobSnapshot,
  validatePersonSourceApproval } from "../server/research-person-source-approval.js";
import { personSourceFingerprint } from "../server/research-person-source-queue.js";

const campaignId = "cmabcdefghijklmnopqrstu";
const workspaceId = "cmabcdefghijklmnopqrstv";
const ownerId = "cmabcdefghijklmnopqrstw";
const observation = number => ({
  id: "cmabcdefghijklmnopqrs" + number,
  name: "Expert Person " + number,
  category: "BUSINESS_STRATEGY",
  citationUrl: "https://example.org/team",
  groundingStatus: "UNCHECKED", groundingResolvedUrl: null,
  groundingProvenance: null, emailTriageStatus: "BLOCKED",
});
const records = [observation("1"), observation("2")];
const jobs = records.map(row => ({
  observationId: row.id, evidenceFingerprint: personSourceFingerprint(row),
  reason: "SHARED_SOURCE", status: "QUEUED",
}));
const validInput = { maxCalls: 2, maxWorstCaseCents: 6,
  confirmPaidSourceResearch: true, confirmNoAutomaticRetry: true,
  confirmPublicInspection: true };
const scope = { campaignId, workspaceId, ownerId, input: validInput };
const clock = new Date("2026-11-18T14:00:00.000Z");

function fixture({ revoked = false, status = "PARTIAL", currentJobs = jobs,
  currentRows = records, existingApproval = null, model = "gemini-3-flash-preview" } = {}) {
  const events = [];
  const tx = {
    $queryRaw: async parts => {
      const sql = parts.join(" ");
      if (sql.includes('FROM "PartnerMembership"'))
        return [{ revokedAt: revoked ? clock : null }];
      if (sql.includes('FROM "ResearchCampaign"'))
        return [{ id: campaignId, status }];
      throw new Error("Unexpected SQL");
    },
    researchPersonSourceApproval: {
      findUnique: async () => existingApproval,
      create: async ({ data }) => {
        events.push("created");
        return { ...data, id: "approval-id", status: "APPROVED" };
      },
    },
    researchPersonSourceJob: {
      findMany: async () => currentJobs,
    },
    researchCampaignObservation: {
      findMany: async () => currentRows,
    },
    auditEvent: { create: async ({ data }) => {
      events.push("audit");
      assert.equal(data.metadata.sendingEnabled, false);
      assert.equal(data.metadata.automaticBillableReplay, false);
      assert.equal(JSON.stringify(data.metadata).includes("Expert Person"), false);
    } },
  };
  return { events, db: {
    aiSetting: { findUnique: async () => ({ provider: "gemini", model }) },
    $transaction: async fn => fn(tx),
  } };
}

test("immutable source approval binds provider price and complete job snapshot", async () => {
  const { db, events } = fixture();
  const result = await approvePersonSourceResearch(db, scope, { now: () => clock });
  assert.equal(result.status, 201);
  assert.equal(result.code, "SOURCE_RUN_APPROVED");
  assert.equal(result.approval.maxCalls, 2);
  assert.equal(result.approval.maxWorstCaseCents, 6);
  assert.equal(result.approval.eligibleJobCount, 2);
  assert.equal(result.approval.sendingEnabled, false);
  assert.deepEqual(events, ["created", "audit"]);
});

test("approval requires explicit bounded call count and conservative budget", () => {
  assert.deepEqual(validatePersonSourceApproval(validInput),
    { maxCalls: 2, maxWorstCaseCents: 6 });
  for (const value of [
    { ...validInput, maxCalls: 251 },
    { ...validInput, maxCalls: 0 },
    { ...validInput, maxWorstCaseCents: 50001 },
    { ...validInput, confirmPaidSourceResearch: false },
    { ...validInput, confirmNoAutomaticRetry: false },
    { ...validInput, confirmPublicInspection: false },
    { ...validInput, provider: "openai" },
  ]) assert.throws(() => validatePersonSourceApproval(value), TypeError);
});

test("snapshot is order independent but fails on stale/duplicated jobs", () => {
  assert.equal(personSourceJobSnapshot(jobs),
    personSourceJobSnapshot([...jobs].reverse()));
  assert.notEqual(personSourceJobSnapshot(jobs),
    personSourceJobSnapshot(jobs.map((item, i) => i === 0
      ? { ...item, reason: "PERSON_SOURCE_REQUIRED" } : item)));
  assert.throws(() => personSourceJobSnapshot([...jobs, jobs[0]]), TypeError);
  assert.throws(() => personSourceJobSnapshot([
    { ...jobs[0], status: "RUNNING" },
  ]), TypeError);
});

test("revoked owner, nonterminal campaign and immutable approval fail closed", async () => {
  for (const [options, code] of [
    [{ revoked: true }, "WORKSPACE_ACCESS_REVOKED"],
    [{ status: "RUNNING" }, "DISCOVERY_NOT_TERMINAL"],
    [{ existingApproval: { id: "prior" } }, "SOURCE_RUN_APPROVAL_IMMUTABLE"],
  ]) {
    const { db, events } = fixture(options);
    const result = await approvePersonSourceResearch(db, scope,
      { now: () => clock });
    assert.equal(result.code, code);
    assert.deepEqual(events, []);
  }
});

test("changed identity or triage state after enqueue blocks approval", async () => {
  for (const changed of [
    { ...records[0], name: "Another Person" },
    { ...records[0], emailTriageStatus: "REVIEW_REQUIRED" },
    { ...records[0], citationUrl: "https://other.example.org" },
  ]) {
    const { db, events } = fixture({ currentRows: [changed, records[1]] });
    const result = await approvePersonSourceResearch(db, scope,
      { now: () => clock });
    assert.equal(result.code, "SOURCE_JOB_EVIDENCE_CHANGED");
    assert.deepEqual(events, []);
  }
});

test("price and job count caps cannot silently expand approved source work", async () => {
  const { db: tooFew } = fixture({ currentJobs: [jobs[0]],
    currentRows: [records[0]] });
  const count = await approvePersonSourceResearch(tooFew, scope,
    { now: () => clock });
  assert.equal(count.code, "SOURCE_RUN_CALL_CAP_EXCEEDS_JOBS");
  const { db: badModel } = fixture();
  const budget = await approvePersonSourceResearch(badModel, {
    ...scope, input: { ...validInput, maxWorstCaseCents: 7 },
  }, { now: () => clock });
  assert.equal(budget.code, "SOURCE_RUN_PRICE_ENVELOPE_INVALID");
});
