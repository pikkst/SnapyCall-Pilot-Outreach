import test from "node:test";
import assert from "node:assert/strict";
import { persistGroundingSourceHint, validateGroundingOutcome }
  from "../server/research-grounding-evidence.js";

const campaignId = "cmabcdefghijklmnopqrstu";
const observationId = "cmabcdefghijklmnopqrstv";
const workspaceId = "cmabcdefghijklmnopqrstw";
const ownerId = "cmabcdefghijklmnopqrstx";
const citation = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/ABCDEFGH12345";
const url = "https://experts.example.org/ada";
const scope = { campaignId, observationId, workspaceId, ownerId,
  originalCitationUrl: citation };
const hint = {
  status: "SOURCE_HINT", citationUrl: citation,
  sourceUrl: url, provenance: "GOOGLE_GROUNDING_LOCATION_HEADER",
  identityVerified: false, emailVerified: false,
  contactCreated: false, sendingEnabled: false,
};

function fixture({ revoked = false, campaign = true, observation = true,
  changedCitation = false, prior = null, updateCount = 1 } = {}) {
  const events = [];
  const tx = {
    $queryRaw: async (parts) => {
      const sql = parts.join(" ");
      if (sql.includes('FROM "PartnerMembership"')) return [
        { revokedAt: revoked ? new Date() : null },
      ];
      if (sql.includes('FROM "ResearchCampaign"')) return campaign ?
        [{ id: campaignId }] : [];
      if (sql.includes('FROM "ResearchCampaignObservation"')) return observation ?
        [{
          id: observationId, citationUrl: changedCitation ? "https://different.example.org" : citation,
          groundingStatus: prior?.groundingStatus ?? "UNCHECKED",
          groundingResolvedUrl: prior?.groundingResolvedUrl ?? null,
          groundingProvenance: prior?.groundingProvenance ?? null,
          groundingCode: prior?.groundingCode ?? null,
        }] : [];
      throw new Error("Unexpected SQL");
    },
    researchCampaignObservation: {
      updateMany: async args => {
        events.push({ type: "update", args });
        assert.equal(args.where.citationUrl, citation);
        assert.equal(args.where.groundingStatus, "UNCHECKED");
        assert.equal("emailTriageStatus" in args.data, false);
        assert.equal("candidateId" in args.data, false);
        return { count: updateCount };
      },
    },
    auditEvent: {
      create: async ({ data }) => {
        events.push({ type: "audit", data });
        assert.equal(data.metadata.contactCreated, false);
        assert.equal(data.metadata.sendingEnabled, false);
        assert.equal(data.metadata.providerCalls, 0);
        assert.equal(JSON.stringify(data.metadata).includes(url), false);
      },
    },
  };
  return { db: { $transaction: fn => fn(tx) }, events };
}

test("stores unverified source hint with original citation preserved", async () => {
  const { db, events } = fixture();
  const result = await persistGroundingSourceHint(db, { ...scope, outcome: hint });
  assert.equal(result.status, 201);
  assert.equal(result.groundingStatus, "SOURCE_HINT");
  assert.equal(events.length, 2);
  assert.equal(events[0].args.data.groundingResolvedUrl, url);
  assert.equal(events[0].args.data.groundingProvenance,
    "GOOGLE_GROUNDING_LOCATION_HEADER");
  assert.ok(events[0].args.data.groundingResolvedAt instanceof Date);
});

test("failure records have no URL or contact evidence", async () => {
  const { db, events } = fixture();
  const result = await persistGroundingSourceHint(db, {
    ...scope, outcome: { status: "UNRESOLVED",
      code: "GROUNDING_REDIRECT_UNAVAILABLE" },
  });
  assert.equal(result.groundingStatus, "UNRESOLVED");
  assert.equal(events[0].args.data.groundingResolvedUrl, null);
  assert.equal(events[0].args.data.groundingCode,
    "GROUNDING_REDIRECT_UNAVAILABLE");
});

test("same evidence replay is read-only and altered resolution is immutable", async () => {
  const prior = validateGroundingOutcome(citation, hint);
  const replay = fixture({ prior });
  assert.equal((await persistGroundingSourceHint(replay.db,
    { ...scope, outcome: hint })).code, "GROUNDING_EVIDENCE_ALREADY_SAVED");
  assert.equal(replay.events.length, 0);
  const changed = await persistGroundingSourceHint(replay.db,
    { ...scope, outcome: { status: "REJECTED",
      code: "GROUNDING_DESTINATION_INVALID" } });
  assert.equal(changed.code, "GROUNDING_EVIDENCE_IMMUTABLE");
});

test("revocation, wrong owner, missing observation and stale citations block mutations", async () => {
  for (const [settings, expected] of [
    [{ revoked: true }, "WORKSPACE_ACCESS_REVOKED"],
    [{ campaign: false }, "CAMPAIGN_NOT_FOUND"],
    [{ observation: false }, "OBSERVATION_NOT_FOUND"],
    [{ changedCitation: true }, "GROUNDING_CITATION_CHANGED"],
    [{ updateCount: 0 }, "GROUNDING_EVIDENCE_CONFLICT"],
  ]) {
    const { db, events } = fixture(settings);
    const result = await persistGroundingSourceHint(db,
      { ...scope, outcome: hint });
    assert.equal(result.code, expected);
    assert.equal(events.some(e => e.type === "audit"), false);
  }
});

test("forged, contradictory and non-Google outcomes fail before DB access", async () => {
  for (const outcome of [
    { ...hint, citationUrl: "https://other.example.org" },
    { ...hint, identityVerified: true },
    { ...hint, sourceUrl: "https://127.0.0.1/" },
    { ...hint, sourceUrl: citation },
    { status: "SOURCE_HINT", sourceUrl: url },
    { status: "REJECTED", code: "SOMETHING_UNKNOWN" },
  ]) assert.throws(() => validateGroundingOutcome(citation, outcome), TypeError);
  const { db, events } = fixture();
  await assert.rejects(() => persistGroundingSourceHint(db,
    { ...scope, observationId: "wrong-id", outcome: hint }), TypeError);
  assert.equal(events.length, 0);
});
