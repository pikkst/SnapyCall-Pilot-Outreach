import test from "node:test";
import assert from "node:assert/strict";
import { tickGroundingResolution, groundingResolutionSummary }
  from "../server/research-grounding-worker.js";

const campaignId = "cmabcdefghijklmnopqrstu";
const workspaceId = "cmabcdefghijklmnopqrstv";
const ownerId = "cmabcdefghijklmnopqrstw";
const observationId = "cmabcdefghijklmnopqrstx";
const citation = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/ABCDEFGH12345";
const source = "https://experts.example.org/ada";
const now = new Date("2026-11-17T12:00:00Z");

function fixture({ revoked = false, failedWrite = false,
  priorLease = null } = {}) {
  const events = [];
  const data = {
    groundingRunStatus: "RUNNING",
    groundingStatus: "UNCHECKED",
    groundingLeaseToken: priorLease,
    groundingLeaseUntil: priorLease ? new Date(0) : null,
    groundingResolvedUrl: null,
    groundingProvenance: null,
    groundingCode: null,
  };
  const tx = {
    $queryRaw: async parts => {
      const sql = parts.join(" ");
      if (sql.includes('FROM "PartnerMembership"')) {
        return [{ revokedAt: revoked ? now : null }];
      }
      if (sql.includes('FROM "ResearchCampaignObservation"')) {
        return [{
          id: observationId, citationUrl: citation,
          ...data,
        }];
      }
      if (sql.includes('FROM "ResearchCampaign"')) {
        return [{
          id: campaignId, groundingRunStatus: data.groundingRunStatus,
          groundingRunExpiresAt: new Date("2026-11-18T12:00:00Z"),
          groundingRunMaxSources: 1,
        }];
      }
      throw Error("Unknown SQL " + sql);
    },
    researchCampaignObservation: {
      count: async ({ where }) => where.groundingStatus?.not ? (
        data.groundingStatus !== "UNCHECKED" ? 1 : 0
      ) : 1,
      findFirst: async () => data.groundingLeaseToken ? {
        groundingLeaseUntil: data.groundingLeaseUntil,
      } : null,
      updateMany: async ({ data: update }) => {
        if (failedWrite && "groundingStatus" in update) return { count: 0 };
        Object.assign(data, update);
        events.push("observation-updated");
        return { count: 1 };
      },
    },
    researchCampaign: {
      update: async ({ data: update }) => {
        Object.assign(data, update);
        events.push("campaign-updated");
      },
    },
    auditEvent: {
      create: async ({ data: audit }) => {
        events.push("audit");
        assert.equal(audit.metadata.sendingEnabled, false);
        assert.equal(audit.metadata.providerCalls, 0);
        assert.equal(JSON.stringify(audit.metadata).includes(source), false);
      },
    },
  };
  const db = {
    researchCampaign: {
      findFirst: async () => ({
        id: campaignId, workspaceId, ownerId,
      }),
    },
    $transaction: async fn => fn(tx),
    researchCampaignObservation: {
      groupBy: async () => [
        { groundingStatus: "SOURCE_HINT", _count: { id: 2 } },
        { groundingStatus: "UNCHECKED", _count: { id: 3 } },
      ],
      count: async () => 1,
    },
  };
  return { db, events, data };
}

test("approved tick claims before HTTP and saves an unverified source hint", async () => {
  const { db, events, data } = fixture();
  const outcome = await tickGroundingResolution(db, {
    now: () => now,
    resolve: async input => {
      assert.equal(input, citation);
      assert.deepEqual(events, ["observation-updated"]);
      return {
        status: "SOURCE_HINT", citationUrl: citation, sourceUrl: source,
        provenance: "GOOGLE_GROUNDING_LOCATION_HEADER",
        identityVerified: false, emailVerified: false,
        contactCreated: false, sendingEnabled: false,
      };
    },
  });
  assert.equal(outcome.status, "SOURCE_HINT");
  assert.equal(outcome.providerCalls, 0);
  assert.equal(outcome.contactCreated, false);
  assert.equal(data.groundingStatus, "SOURCE_HINT");
  assert.equal(data.groundingResolvedUrl, source);
  assert.equal(data.groundingLeaseToken, null);
  assert.deepEqual(events, ["observation-updated", "observation-updated", "audit"]);
});

test("HTTP transport uncertainty records only a safe failure", async () => {
  const { db, data } = fixture();
  const outcome = await tickGroundingResolution(db, {
    now: () => now,
    resolve: async () => { throw Error("private network detail"); },
  });
  assert.equal(outcome.status, "UNRESOLVED");
  assert.equal(data.groundingCode, "GROUNDING_REDIRECT_UNAVAILABLE");
  assert.equal(data.groundingResolvedUrl, null);
});

test("unknown DB result leaves claim and never attempts another HEAD", async () => {
  const { db, data } = fixture({ failedWrite: true });
  // A failed post-claim write cannot safely trigger HTTP replay.
  const result = await tickGroundingResolution(db, {
    now: () => now,
    resolve: async () => ({
      status: "UNRESOLVED", code: "GROUNDING_REDIRECT_UNAVAILABLE",
    }),
  });
  assert.equal(result.status, "REVIEW_REQUIRED");
  assert.equal(result.code, "GROUNDING_EVIDENCE_CONFLICT");
  assert.ok(data.groundingLeaseToken);
  assert.equal(data.groundingStatus, "UNCHECKED");
});

test("revoked workspace must not dispatch any external HEAD", async () => {
  const { db } = fixture({ revoked: true });
  const result = await tickGroundingResolution(db, {
    now: () => now,
    resolve: async () => { throw Error("should not call network"); },
  });
  assert.equal(result.status, "ACCESS_REVOKED");
});

test("source-resolution summary has no contacts, sends or provider spending", async () => {
  const { db } = fixture();
  const result = await groundingResolutionSummary(db, {
    campaignId, workspaceId, ownerId,
  });
  assert.deepEqual({
    sourceHints: result.sourceHints, remaining: result.remaining,
    checking: result.checking, verifiedEmails: result.verifiedEmails,
    contactsCreated: result.contactsCreated, providerCalls: result.providerCalls,
    sendingEnabled: result.sendingEnabled,
  }, {
    sourceHints: 2, remaining: 3, checking: 1, verifiedEmails: 0,
    contactsCreated: 0, providerCalls: 0, sendingEnabled: false,
  });
});
