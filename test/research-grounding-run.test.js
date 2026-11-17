import test from "node:test";
import assert from "node:assert/strict";
import { approveGroundingResolution, claimGroundingObservation,
  stopGroundingResolution } from "../server/research-grounding-run.js";
import { persistGroundingSourceHint } from "../server/research-grounding-evidence.js";

const campaignId = "cmabcdefghijklmnopqrstu";
const workspaceId = "cmabcdefghijklmnopqrstv";
const ownerId = "cmabcdefghijklmnopqrstw";
const observationId = "cmabcdefghijklmnopqrstx";
const citation = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/ABCDEFGH12345";
const direct = "https://experts.example.org/ada";
const scope = { campaignId, workspaceId, ownerId };
const clock = new Date("2026-11-17T12:00:00Z");
const expiry = new Date("2026-11-18T12:00:00Z");
const existingToken = "test-token-123456789";

function fixture({
  revoked = false, discoveryStatus = "COMPLETED",
  runStatus = "IDLE", sources = [citation, citation],
  approvedCount = 2, inFlight = null, attempted = 0, missing = false,
  leaseExpired = false, mutationCount = 1,
} = {}) {
  const events = [];
  const tx = {
    $queryRaw: async parts => {
      const sql = parts.join(" ");
      if (sql.includes('FROM "PartnerMembership"')) return [
        { revokedAt: revoked ? clock : null },
      ];
      if (sql.includes('FROM "ResearchCampaignObservation"')) {
        return [{ id: observationId, citationUrl: citation }];
      }
      if (sql.includes('FROM "ResearchCampaign"')) return missing ? [] : [{
        id: campaignId, status: discoveryStatus,
        groundingRunStatus: runStatus, groundingRunMaxSources: approvedCount,
        groundingRunExpiresAt: leaseExpired ? new Date(0) : expiry,
      }];
      throw Error("Unexpected SQL " + sql);
    },
    researchCampaignObservation: {
      findMany: async () => sources.map((citationUrl, index) => ({
        id: "observation-" + index,
        citationUrl, groundingStatus: "UNCHECKED", groundingLeaseToken: null,
      })),
      findFirst: async () => inFlight,
      count: async ({ where }) => where.groundingStatus?.not ? attempted : sources.length,
      updateMany: async ({ data }) => {
        events.push({ kind: "observation", data });
        return { count: mutationCount };
      },
    },
    researchCampaign: {
      update: async ({ data }) => {
        events.push({ kind: "campaign", data }); return data;
      },
    },
    auditEvent: {
      create: async ({ data }) => {
        events.push({ kind: "audit", data });
        assert.equal(data.metadata.sendingEnabled, false);
        assert.equal(JSON.stringify(data.metadata).includes(direct), false);
      },
    },
  };
  return { db: { $transaction: fn => fn(tx) }, events };
}

test("approval is bounded, immutable and never makes external calls", async () => {
  const { db, events } = fixture();
  const approved = await approveGroundingResolution(db, {
    ...scope, maxSources: 2, confirmPublicRequests: true,
  }, { now: () => clock });
  assert.equal(approved.status, 201);
  assert.equal(approved.code, "GROUNDING_APPROVED");
  assert.ok(events.some(e => e.kind === "campaign" &&
    e.data.groundingRunStatus === "RUNNING"));
  assert.ok(events.some(e => e.kind === "audit"));
});

test("approval rejects revoked owner, incomplete discovery, mixed citations and count drift", async () => {
  for (const [options, expected] of [
    [{ revoked: true }, "WORKSPACE_ACCESS_REVOKED"],
    [{ discoveryStatus: "RUNNING" }, "DISCOVERY_NOT_TERMINAL"],
    [{ runStatus: "RUNNING" }, "GROUNDING_APPROVAL_IMMUTABLE"],
    [{ sources: [citation, direct] }, "GROUNDING_CITATION_REQUIRES_REVIEW"],
    [{ sources: [citation] }, "GROUNDING_APPROVAL_COUNT_MISMATCH"],
    [{ missing: true }, "CAMPAIGN_NOT_FOUND"],
  ]) {
    const { db, events } = fixture(options);
    const res = await approveGroundingResolution(db, {
      ...scope, maxSources: 2, confirmPublicRequests: true,
    }, { now: () => clock });
    assert.equal(res.code, expected);
    assert.equal(events.some(e => e.kind === "campaign"), false);
  }
  await assert.rejects(() => approveGroundingResolution(fixture().db,
    { ...scope, maxSources: 251, confirmPublicRequests: true }), TypeError);
});

test("one claim obtains a persisted lease before external HTTP", async () => {
  const { db, events } = fixture({ runStatus: "RUNNING" });
  const claimed = await claimGroundingObservation(db, scope, {
    now: () => clock,
  });
  assert.equal(claimed.status, "CLAIMED");
  assert.equal(claimed.citationUrl, citation);
  assert.equal(claimed.observationId, observationId);
  assert.ok(claimed.token.length >= 10);
  assert.equal(claimed.leaseUntil.getTime(), clock.getTime() + 60_000);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "observation");
  assert.ok(events[0].data.groundingLeaseToken);
});

test("in-flight, stale lease and expired approval do not replay", async () => {
  const active = await claimGroundingObservation(fixture({
    runStatus: "RUNNING", inFlight: { groundingLeaseUntil: expiry },
  }).db, scope, { now: () => clock });
  assert.equal(active.status, "IN_FLIGHT");
  const { db, events } = fixture({
    runStatus: "RUNNING", inFlight: { groundingLeaseUntil: new Date(0) },
  });
  assert.equal((await claimGroundingObservation(db, scope, {
    now: () => clock,
  })).status, "LEASE_REVIEW_REQUIRED");
  assert.ok(events.some(e => e.data?.groundingRunStatus === "PAUSED"));
  assert.equal(events.some(e => e.kind === "observation"), false);
  const expired = await claimGroundingObservation(fixture({
    runStatus: "RUNNING", leaseExpired: true,
  }).db, scope, { now: () => clock });
  assert.equal(expired.status, "EXPIRED");
});

test("source-count drift pauses before dispatch, even with previous approval", async () => {
  const { db, events } = fixture({
    runStatus: "RUNNING", sources: [citation],
  });
  const res = await claimGroundingObservation(db, scope, {
    now: () => clock,
  });
  assert.equal(res.status, "SOURCE_SNAPSHOT_CHANGED");
  assert.equal(events.some(e => e.kind === "observation"), false);
});

test("stop is idempotent, owner scoped, and prevents future claims", async () => {
  const { db, events } = fixture({ runStatus: "RUNNING" });
  assert.equal((await stopGroundingResolution(db, scope)).code, "GROUNDING_STOPPED");
  assert.ok(events.some(e => e.data?.groundingRunStatus === "PAUSED"));
  assert.equal((await stopGroundingResolution(fixture({
    runStatus: "PAUSED",
  }).db, scope)).code, "GROUNDING_NOT_RUNNING");
  assert.equal((await claimGroundingObservation(fixture({
    runStatus: "PAUSED",
  }).db, scope)).status, "NOT_RUNNING");
});

test("identical evidence replay is read-only after successful claim clearance", async () => {
  const { db, events } = fixture({ runStatus: "RUNNING" });
  const original = db.$transaction;
  db.$transaction = fn => original(tx => {
    const query = tx.$queryRaw;
    tx.$queryRaw = async parts => {
      if (parts.join(" ").includes('FROM "ResearchCampaignObservation"')) {
        return [{
          id: observationId, citationUrl: citation,
          groundingStatus: "SOURCE_HINT",
          groundingResolvedUrl: "https://experts.example.org/ada",
          groundingProvenance: "GOOGLE_GROUNDING_LOCATION_HEADER",
          groundingCode: null,
          groundingLeaseToken: null,
          groundingLeaseUntil: null,
        }];
      }
      return query(parts);
    };
    return fn(tx);
  });
  const same = await persistGroundingSourceHint(db, {
    ...scope, observationId, originalCitationUrl: citation,
    claimToken: existingToken,
    outcome: {
      status: "SOURCE_HINT", citationUrl: citation,
      sourceUrl: "https://experts.example.org/ada",
      provenance: "GOOGLE_GROUNDING_LOCATION_HEADER",
      identityVerified: false, emailVerified: false,
      contactCreated: false, sendingEnabled: false,
    },
  }, { now: () => clock });
  assert.equal(same.code, "GROUNDING_EVIDENCE_ALREADY_SAVED");
  assert.equal(events.length, 0);
  const conflicting = await persistGroundingSourceHint(db, {
    ...scope, observationId, originalCitationUrl: citation,
    claimToken: existingToken,
    outcome: { status: "REJECTED", code: "GROUNDING_DESTINATION_INVALID" },
  }, { now: () => clock });
  assert.equal(conflicting.code, "GROUNDING_EVIDENCE_IMMUTABLE");
  assert.equal(events.length, 0);
});

test("persisted claimed evidence requires matching live token, and clears lease", async () => {
  const active = fixture({ runStatus: "RUNNING" });
  const original = active.db.$transaction;
  active.db.$transaction = fn => original(tx => {
    const query = tx.$queryRaw;
    tx.$queryRaw = async parts => {
      const sql = parts.join(" ");
      if (sql.includes('FROM "ResearchCampaignObservation"')) return [{
        id: observationId, citationUrl: citation, groundingStatus: "UNCHECKED",
        groundingResolvedUrl: null, groundingProvenance: null,
        groundingCode: null, groundingLeaseToken: existingToken,
        groundingLeaseUntil: expiry,
      }];
      return query(parts);
    };
    return fn(tx);
  });
  const input = {
    ...scope, observationId, originalCitationUrl: citation,
    outcome: { status: "UNRESOLVED", code: "GROUNDING_REDIRECT_UNAVAILABLE" },
  };
  const missingToken = await persistGroundingSourceHint(active.db, input,
    { now: () => clock });
  assert.equal(missingToken.code, "GROUNDING_LEASE_UNCONFIRMED");
  const recorded = await persistGroundingSourceHint(active.db, {
    ...input, claimToken: existingToken,
  }, { now: () => clock });
  assert.equal(recorded.code, "GROUNDING_EVIDENCE_RECORDED");
  const change = active.events.find(e => e.kind === "observation");
  assert.equal(change.data.groundingLeaseToken, null);
  assert.equal(change.data.groundingLeaseUntil, null);
  const stale = await persistGroundingSourceHint(active.db, {
    ...input, claimToken: "wrong-token",
  }, { now: () => clock });
  assert.equal(stale.code, "GROUNDING_LEASE_UNCONFIRMED");
});
