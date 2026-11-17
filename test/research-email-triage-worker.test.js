import test from "node:test";
import assert from "node:assert/strict";
import { approveEmailTriage, claimEmailTriageObservation,
  finishEmailTriageObservation, stopEmailTriage, emailTriageSummary,
  tickEmailTriage } from "../server/research-email-triage-worker.js";

const campaignId = "cmabcdefghijklmnopqrstu";
const workspaceId = "cmabcdefghijklmnopqrstv";
const ownerId = "cmabcdefghijklmnopqrstw";
const observationId = "cmabcdefghijklmnopqrstx";
const scope = { campaignId, workspaceId, ownerId };
const now = new Date("2026-11-17T12:00:00.000Z");
const expires = new Date("2026-11-18T12:00:00.000Z");
const digest = "a".repeat(64);

function fixture({ status = "RUNNING", discovery = "COMPLETED",
  observed = 5, checking = 0, inspected = 0, expired = false,
  revoked = false, stale = false, prior = false,
  sourceUrl = "https://experts.example.org/ada" } = {}) {
  const events = [];
  const tx = {
    $queryRaw: async (parts) => {
      const query = parts.join(" ");
      if (query.includes('FROM "PartnerMembership"')) return revoked ?
        [{ revokedAt: now }] : [{ revokedAt: null }];
      if (query.includes('FROM "ResearchCampaign"')) return [{
        id: campaignId, status: discovery,
        emailTriageStatus: prior ? "RUNNING" : status,
        emailTriageMaxPages: 5,
        emailTriageExpiresAt: expired ? new Date(0) : expires,
      }];
      if (query.includes('FROM "ResearchCampaignObservation"')) {
        events.push("observation-locked");
        return [{ id: observationId }];
      }
      throw new Error("Unexpected query: " + query);
    },
    researchCampaign: {
      update: async ({ data }) => { events.push("campaign-" + data.emailTriageStatus);
        return data; },
    },
    researchCampaignObservation: {
      findMany: async () => Array.from({ length: observed },
        () => ({ citationUrl: sourceUrl })),
      count: async ({ where }) => {
        if (where.emailTriageStatus === "CHECKING" &&
            where.emailTriageLeaseUntil) return stale ? 1 : 0;
        if (where.emailTriageStatus === "CHECKING") return checking;
        if (where.emailTriageStatus?.not === "UNCHECKED") return inspected;
        return observed;
      },
      updateMany: async ({ data }) => {
        events.push("observation-" + data.emailTriageStatus);
        if (data.emailTriageStatus === "REVIEW_REQUIRED") {
          assert.equal(data.emailTriageEmail, "ada@example.org");
          assert.equal(data.emailTriageDigest, digest);
        } else if (data.emailTriageStatus !== "CHECKING") {
          assert.equal(data.emailTriageEmail, null);
          assert.equal(data.emailTriageDigest, null);
        }
        return { count: 1 };
      },
    },
    auditEvent: { create: async ({ data }) => {
      events.push(data.action);
      assert.equal(JSON.stringify(data.metadata).includes("ada@"), false);
      assert.equal(data.metadata.sendingEnabled, false);
    } },
  };
  return { db: { $transaction: async fn => fn(tx) }, events };
}

test("approval is explicit, bounded and uses no provider", async () => {
  const { db, events } = fixture({ status: "IDLE" });
  const result = await approveEmailTriage(db, {
    ...scope, maxPages: 5, confirmPublicInspection: true,
  }, { now: () => now });
  assert.equal(result.status, 201);
  assert.equal(result.providerCallsAuthorized, false);
  assert.ok(events.includes("campaign-RUNNING"));
  assert.ok(events.includes("research.campaign.email-triage.approved"));
});

test("no auth, nonterminal campaign and repeated approval are rejected", async () => {
  for (const [options, code] of [
    [{ revoked: true, status: "IDLE" }, "WORKSPACE_ACCESS_REVOKED"],
    [{ discovery: "RUNNING", status: "IDLE" }, "DISCOVERY_NOT_TERMINAL"],
    [{ prior: true, status: "IDLE" }, "EMAIL_TRIAGE_APPROVAL_IMMUTABLE"],
    [{ observed: 6, status: "IDLE" }, "EMAIL_TRIAGE_PAGE_CAP_EXCEEDED"],
  ]) {
    const { db, events } = fixture(options);
    const outcome = await approveEmailTriage(db, {
      ...scope, maxPages: 5, confirmPublicInspection: true,
    }, { now: () => now });
    assert.equal(outcome.code, code);
    assert.equal(events.some(e => e === "campaign-RUNNING"), false);
  }
  const { db } = fixture();
  await assert.rejects(() => approveEmailTriage(db, {
    ...scope, maxPages: 251, confirmPublicInspection: true,
  }), TypeError);
});

test("all-opaque Gemini citations cannot authorize a misleading email triage batch", async () => {
  const { db, events } = fixture({
    status: "IDLE", observed: 233,
    sourceUrl: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque",
  });
  const result = await approveEmailTriage(db, {
    ...scope, maxPages: 233, confirmPublicInspection: true,
  }, { now: () => now });
  assert.equal(result.status, 409);
  assert.equal(result.code, "EMAIL_TRIAGE_DIRECT_SOURCE_REQUIRED");
  assert.equal(result.inspectableObservations, 0);
  assert.equal(result.availableObservations, 233);
  assert.equal(events.includes("campaign-RUNNING"), false);
  assert.equal(events.includes("research.campaign.email-triage.approved"), false);
});

test("claim persists a lease and never makes a billable call", async () => {
  const { db, events } = fixture();
  const claim = await claimEmailTriageObservation(db, scope, { now: () => now });
  assert.equal(claim.status, "CLAIMED");
  assert.equal(claim.observationId, observationId);
  assert.equal(claim.leaseUntil.getTime(), now.getTime() + 60_000);
  assert.deepEqual(events, ["observation-locked", "observation-CHECKING"]);
});

test("active or expired lease cannot be automatically replayed", async () => {
  const active = await claimEmailTriageObservation(fixture({ checking: 1 }).db,
    scope, { now: () => now });
  assert.equal(active.status, "IN_FLIGHT");
  const { db, events } = fixture({ checking: 1, stale: true });
  const blocked = await claimEmailTriageObservation(db, scope, { now: () => now });
  assert.equal(blocked.status, "LEASE_REVIEW_REQUIRED");
  assert.ok(events.includes("campaign-PAUSED"));
  assert.equal(events.includes("observation-CHECKING"), false);
});

test("expired authorization pauses before inspecting any new source", async () => {
  const { db, events } = fixture({ expired: true });
  const result = await claimEmailTriageObservation(db, scope, { now: () => now });
  assert.equal(result.status, "EXPIRED");
  assert.deepEqual(events, ["campaign-PAUSED"]);
});

test("named email is persisted only as REVIEW_REQUIRED evidence", async () => {
  const { db, events } = fixture();
  const result = await finishEmailTriageObservation(db, {
    ...scope, observationId, token: "lease-token-for-test",
    status: "CLAIMED", leaseUntil: expires,
  }, { code: "NAMED_EMAIL_EVIDENCE_REVIEW_REQUIRED",
    observedEmail: "ada@example.org", evidenceDigest: digest },
  { now: () => now });
  assert.equal(result.status, "REVIEW_REQUIRED");
  assert.ok(events.includes("observation-REVIEW_REQUIRED"));
  assert.equal(events.includes("candidate-create"), false);
});

test("no email, shared source and lookup failure never create email contacts", async () => {
  for (const [code, expected] of [
    ["ADDRESS_AMBIGUOUS_OR_NOT_PUBLISHED", "NO_EMAIL"],
    ["SHARED_SOURCE_REQUIRES_REVIEW", "BLOCKED"],
    ["PROFILE_INSPECTION_UNAVAILABLE", "BLOCKED"],
  ]) {
    const { db, events } = fixture();
    const result = await finishEmailTriageObservation(db, {
      ...scope, observationId, token: "lease-token-for-test",
      status: "CLAIMED",
    }, { code }, { now: () => now });
    assert.equal(result.status, expected);
    assert.equal(events.includes("candidate-create"), false);
  }
});

test("owner stop is idempotent and prevents future claims", async () => {
  const { db, events } = fixture();
  const result = await stopEmailTriage(db, scope);
  assert.equal(result.code, "EMAIL_TRIAGE_STOPPED");
  assert.ok(events.includes("campaign-PAUSED"));
  const second = await stopEmailTriage(fixture({ status: "PAUSED" }).db, scope);
  assert.equal(second.code, "EMAIL_TRIAGE_NOT_RUNNING");
});

test("worker tick invokes only the preexisting bounded profile inspector", async () => {
  const events = [];
  const db = {
    researchCampaign: { findFirst: async () => ({
      id: campaignId, workspaceId, ownerId,
    }) },
    $transaction: async fn => fn({
      $queryRaw: async parts => {
        const sql = parts.join(" ");
        if (sql.includes("PartnerMembership")) return [{ revokedAt: null }];
        if (sql.includes('FROM "ResearchCampaign"')) return [{
          id: campaignId, emailTriageStatus: "RUNNING",
          emailTriageExpiresAt: expires, emailTriageMaxPages: 5,
        }];
        if (sql.includes('FROM "ResearchCampaignObservation"')) return [{ id: observationId }];
        throw new Error("Unexpected SQL");
      },
      researchCampaignObservation: {
        count: async () => 0,
        updateMany: async ({ data }) => {
          events.push("write-" + data.emailTriageStatus);
          return { count: 1 };
        },
      },
      auditEvent: { create: async () => events.push("audit") },
    }),
  };
  const result = await tickEmailTriage(db, {
    now: () => now,
    inspect: async (_db, args) => {
      events.push("inspected");
      assert.equal(args.observationId, observationId);
      return { code: "ADDRESS_AMBIGUOUS_OR_NOT_PUBLISHED" };
    },
  });
  assert.equal(result.status, "NO_EMAIL");
  assert.deepEqual(events, ["write-CHECKING", "inspected", "write-NO_EMAIL", "audit"]);
});

test("summary reports independently verified observations, not email contacts", () => {
  const result = emailTriageSummary({
    emailTriageStatus: "COMPLETED", emailTriageMaxPages: 10,
    emailTriageExpiresAt: expires,
  }, [
    { emailTriageStatus: "REVIEW_REQUIRED", _count: { id: 4 } },
    { emailTriageStatus: "NO_EMAIL", _count: { id: 5 } },
    { emailTriageStatus: "BLOCKED", _count: { id: 1 } },
  ]);
  assert.equal(result.reviewRequired, 4);
  assert.equal(result.contactsCreated, 0);
  assert.equal(result.providerCalls, 0);
  assert.equal(result.sendingEnabled, false);
});
