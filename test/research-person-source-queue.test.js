import test from "node:test";
import assert from "node:assert/strict";
import { enqueuePersonSourceJobs, personSourceFingerprint }
  from "../server/research-person-source-queue.js";

const campaignId = "cmabcdefghijklmnopqrstu";
const workspaceId = "cmabcdefghijklmnopqrstv";
const ownerId = "cmabcdefghijklmnopqrstw";
const scope = { campaignId, workspaceId, ownerId,
  confirmQueuePreparation: true };
const citationUrl = "https://people.example.org/team";
const observations = [1, 2].map(i => ({
  id: "cmabcdefghijklmnopqrs" + i,
  name: "Expert Person " + i, category: "BUSINESS_STRATEGY",
  citationUrl, groundingStatus: "UNCHECKED",
  groundingResolvedUrl: null, groundingProvenance: null,
  emailTriageStatus: "BLOCKED",
}));

function fixture({ revoked = false, campaignStatus = "PARTIAL",
  rows = observations, existing = [], approvalExists = false } = {}) {
  const writes = [];
  const jobs = [...existing];
  const tx = {
    $queryRaw: async parts => {
      const sql = parts.join(" ");
      if (sql.includes('FROM "PartnerMembership"'))
        return revoked ? [{ revokedAt: new Date() }] : [{ revokedAt: null }];
      if (sql.includes('FROM "ResearchCampaign"'))
        return [{ id: campaignId, status: campaignStatus }];
      throw new Error("Unexpected SQL");
    },
    researchPersonSourceApproval: {
      findUnique: async () => approvalExists ? { id: "prior-approval" } : null,
    },
    researchCampaignObservation: {
      count: async () => rows.length,
      findMany: async () => rows,
    },
    researchPersonSourceJob: {
      findMany: async () => jobs.map(x => ({
        observationId: x.observationId,
        evidenceFingerprint: x.evidenceFingerprint,
      })),
      createMany: async ({ data, skipDuplicates }) => {
        assert.equal(skipDuplicates, true);
        let count = 0;
        for (const item of data) {
          if (!jobs.some(existingJob => existingJob.observationId ===
              item.observationId)) {
            jobs.push(item);
            count++;
          }
        }
        writes.push("jobs");
        return { count };
      },
    },
    auditEvent: { create: async ({ data }) => {
      assert.equal(data.metadata.providerCallsAuthorized, false);
      assert.equal(data.metadata.sendingEnabled, false);
      assert.equal(JSON.stringify(data.metadata).includes("Expert"), false);
      writes.push("audit");
    } },
  };
  return { db: { $transaction: async fn => fn(tx) }, writes, jobs };
}

test("queues each unresolved observation under an explicit owner-scoped action", async () => {
  const { db, jobs, writes } = fixture();
  const result = await enqueuePersonSourceJobs(db, scope);
  assert.equal(result.code, "PERSON_SOURCE_JOBS_QUEUED");
  assert.equal(result.jobsAdded, 2);
  assert.equal(jobs.length, 2);
  assert.notEqual(jobs[0].observationId, jobs[1].observationId);
  assert.equal(jobs[0].status, "QUEUED");
  assert.match(jobs[0].evidenceFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(jobs[0].reason, "SHARED_SOURCE");
  assert.deepEqual(writes, ["jobs", "audit"]);
});

test("exact replay adds no jobs, audit or provider calls", async () => {
  const state = fixture();
  await enqueuePersonSourceJobs(state.db, scope);
  state.writes.length = 0;
  const replay = await enqueuePersonSourceJobs(state.db, scope);
  assert.equal(replay.jobsAdded, 0);
  assert.equal(replay.code, "PERSON_SOURCE_JOBS_UNCHANGED");
  assert.deepEqual(state.writes, ["jobs"]);
  assert.equal(state.jobs.length, 2);
});

test("stale evidence is never silently rebound to a previous job", async () => {
  const existing = observations.map(row => ({
    observationId: row.id, evidenceFingerprint: personSourceFingerprint(row),
  }));
  const changed = observations.map((row, index) => index === 0
    ? { ...row, name: "Other Expert Name" } : row);
  const state = fixture({ rows: changed, existing });
  const result = await enqueuePersonSourceJobs(state.db, scope);
  assert.equal(result.code, "SOURCE_RESOLUTION_JOB_DRIFT");
  assert.deepEqual(state.writes, []);
});

test("revoked membership, nonterminal campaign and oversized batch fail closed", async () => {
  const revoked = fixture({ revoked: true });
  assert.equal((await enqueuePersonSourceJobs(revoked.db, scope)).status, 403);
  assert.deepEqual(revoked.writes, []);
  const running = fixture({ campaignStatus: "RUNNING" });
  assert.equal((await enqueuePersonSourceJobs(running.db, scope)).code,
    "DISCOVERY_NOT_TERMINAL");
  const oversized = fixture({ rows: Array(251).fill(observations[0]) });
  assert.equal((await enqueuePersonSourceJobs(oversized.db, scope)).code,
    "SOURCE_RESOLUTION_QUEUE_CAP_EXCEEDED");
  assert.deepEqual(oversized.writes, []);
});

test("queue preparation is not implicit authorization", async () => {
  const { db } = fixture();
  await assert.rejects(() => enqueuePersonSourceJobs(db, {
    ...scope, confirmQueuePreparation: false,
  }), TypeError);
});

test("immutable source approval freezes the queue and prevents newly appended jobs", async () => {
  const state = fixture({ approvalExists: true });
  const result = await enqueuePersonSourceJobs(state.db, scope);
  assert.equal(result.status, 409);
  assert.equal(result.code, "SOURCE_JOB_MANIFEST_FROZEN");
  assert.deepEqual(state.writes, []);
  assert.equal(state.jobs.length, 0);
});
