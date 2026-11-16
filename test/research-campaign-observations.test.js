import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCampaignObservations, commitCampaignResearchResult,
  summarizeCampaignProgress, CampaignLeaseConflict
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
    researchCampaignTask: { updateMany: async input => {
      calls.push(["fence", input.where.leaseToken, input.data.status]);
      return { count: 1 };
    } },
    researchCampaignObservation: { createMany: async input => {
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
