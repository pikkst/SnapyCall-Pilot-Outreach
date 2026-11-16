import test from "node:test";
import assert from "node:assert/strict";
import {
  commitCampaignResearchResult, CampaignLeaseConflict,
} from "../server/research-campaign-observations.js";

const claim = { campaignId: "campaign-a", taskId: "task-a",
  workspaceId: "workspace-a", ownerId: "owner-a",
  leaseToken: "token-a", limit: 10 };
const url = "https://example.org/experts/ada";
const result = { sources: [{ url }],
  candidates: [{ name: "Ada Mentor", category: "AI_AUTOMATION",
    sourceUrl: url, rationale: "Publicly sourced independent AI consultant." }] };

function mock({ unique = 100, target = 100, unsettled = 0, queued = 5,
  fence = true, transitionCount = 1 } = {}) {
  const events = [];
  const tx = {
    $queryRaw: async () => [{ id: claim.campaignId }],
    researchCampaignTask: {
      count: async ({ where }) => where.status === "QUEUED" ? queued : unsettled,
      updateMany: async ({ data }) => {
        events.push("task-" + data.status);
        return { count: fence ? 1 : 0 };
      },
    },
    researchCampaignObservation: {
      createMany: async () => {
        events.push("saved-evidence");
        return { count: 1 };
      },
      count: async () => unique,
    },
    researchCampaign: {
      findFirst: async ({ where }) => {
        assert.equal(where.ownerId, claim.ownerId);
        assert.equal(where.workspaceId, claim.workspaceId);
        return { targetCount: target };
      },
      updateMany: async ({ where, data }) => {
        events.push("campaign-" + data.status);
        assert.equal(where.status, "RUNNING");
        return { count: transitionCount };
      },
    },
    auditEvent: { create: async ({ data }) => {
      events.push("audit-" + data.metadata.status);
      assert.equal(data.metadata.contactVerification, "NOT_PERFORMED");
      assert.equal(data.metadata.sendingEnabled, false);
    } },
  };
  return { events, db: { $transaction: async fn => fn(tx) } };
}

test("target reached finalizes and cancels remaining queued tasks in the evidence transaction", async () => {
  const s = mock();
  const out = await commitCampaignResearchResult(s.db, claim, result);
  assert.equal(out.campaignStatus, "COMPLETED");
  assert.deepEqual(s.events, ["task-COMPLETED", "saved-evidence",
    "task-CANCELLED", "campaign-COMPLETED", "audit-COMPLETED"]);
});

test("all tasks exhausted but target not met finalizes as PARTIAL", async () => {
  const s = mock({ unique: 83, queued: 0 });
  const out = await commitCampaignResearchResult(s.db, claim, result);
  assert.equal(out.campaignStatus, "PARTIAL");
  assert.deepEqual(s.events, ["task-COMPLETED", "saved-evidence",
    "campaign-PARTIAL", "audit-PARTIAL"]);
});

test("a pending task prevents premature PARTIAL even with insufficient source evidence", async () => {
  const s = mock({ unique: 83, queued: 4 });
  const out = await commitCampaignResearchResult(s.db, claim, result);
  assert.equal(out.campaignStatus, undefined);
  assert.deepEqual(s.events, ["task-COMPLETED", "saved-evidence"]);
});

test("another running or paused task blocks terminal state after target reached", async () => {
  for (const unresolved of [1, 2]) {
    const s = mock({ unique: 101, unsettled: unresolved });
    const out = await commitCampaignResearchResult(s.db, claim, result);
    assert.equal(out.campaignStatus, undefined);
    assert.deepEqual(s.events, ["task-COMPLETED", "saved-evidence"]);
  }
});

test("terminal CAS failure must roll back the entire evidence transaction", async () => {
  const s = mock({ transitionCount: 0 });
  await assert.rejects(
    () => commitCampaignResearchResult(s.db, claim, result),
    CampaignLeaseConflict,
  );
  assert.ok(!s.events.includes("audit-COMPLETED"));
});

test("stale lease never reaches evidence write or finalization", async () => {
  const s = mock({ fence: false });
  await assert.rejects(
    () => commitCampaignResearchResult(s.db, claim, result),
    CampaignLeaseConflict,
  );
  assert.deepEqual(s.events, ["task-COMPLETED"]);
});
