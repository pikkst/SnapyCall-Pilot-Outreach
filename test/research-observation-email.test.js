import test from "node:test";
import assert from "node:assert/strict";
import { inspectCampaignObservationEmail, isDirectPublicProfileUrl }
  from "../server/research-observation-email.js";

const campaignId = "cmabcdefghijklmnopqrstu";
const observationId = "cmabcdefghijklmnopqrstv";
const workspaceId = "cmabcdefghijklmnopqrstw";
const ownerId = "cmabcdefghijklmnopqrstx";
const profile = "https://experts.example.org/ada";
const entry = {
  id: observationId, name: "Ada Expert", category: "AI_AUTOMATION",
  citationUrl: profile,
};
const page = {
  url: profile,
  text: "Name: Ada Expert Email: ada@experts.example.org",
};
const scope = { campaignId, observationId, workspaceId, ownerId };

function fakeDb({ owns = true, observation = entry, shared = 0,
  revoked = false } = {}) {
  let memberChecks = 0;
  let retrievedCampaigns = 0;
  return {
    researchCampaign: { findFirst: async () => {
      retrievedCampaigns++;
      return owns ? { id: campaignId } : null;
    } },
    researchCampaignObservation: {
      findFirst: async () => observation,
      count: async () => shared,
    },
    partnerMembership: { findUnique: async () => {
      memberChecks++;
      return {
        id: "membership", role: "PARTNER",
        revokedAt: revoked ? new Date() : null,
        user: { id: ownerId, googleSub: "google-sub" },
      };
    } },
    getChecks: () => ({ memberChecks, retrievedCampaigns }),
  };
}

test("Google grounding redirect is not an independently inspectable person profile", () => {
  assert.equal(isDirectPublicProfileUrl(
    "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc"), null);
  assert.equal(isDirectPublicProfileUrl("https://127.0.0.1/"), null);
  assert.equal(isDirectPublicProfileUrl(profile), profile);
});

test("scoped named public email evidence is returned for review, never imported", async () => {
  let fetches = 0;
  const db = fakeDb();
  const result = await inspectCampaignObservationEmail(db, scope, {
    retrieve: async () => { fetches++; return page; },
  });
  assert.equal(fetches, 1);
  assert.equal(result.status, 200);
  assert.equal(result.code, "NAMED_EMAIL_EVIDENCE_REVIEW_REQUIRED");
  assert.equal(result.observedEmail, "ada@experts.example.org");
  assert.equal(result.name, "Ada Expert");
  assert.equal(result.category, "AI_AUTOMATION");
  assert.match(result.evidenceDigest, /^[a-f0-9]{64}$/);
  assert.equal(result.contactCreated, false);
  assert.equal(result.reviewRequired, true);
  assert.equal(result.sendingEnabled, false);
  assert.equal(db.getChecks().memberChecks, 1);
});

test("unknown campaign and cross-campaign observation trigger no fetch", async () => {
  let fetches = 0;
  const retrieve = async () => { fetches++; return page; };
  assert.deepEqual(await inspectCampaignObservationEmail(fakeDb({ owns: false }),
    scope, { retrieve }), { status: 404, code: "CAMPAIGN_NOT_FOUND" });
  assert.deepEqual(await inspectCampaignObservationEmail(fakeDb({ observation: null }),
    scope, { retrieve }), { status: 404, code: "OBSERVATION_NOT_FOUND" });
  assert.equal(fetches, 0);
});

test("shared URL or provider grounding redirect cannot be bound to a single expert", async () => {
  let fetches = 0;
  const retrieve = async () => { fetches++; return page; };
  const ambiguous = await inspectCampaignObservationEmail(fakeDb({ shared: 1 }),
    scope, { retrieve });
  assert.equal(ambiguous.code, "SHARED_SOURCE_REQUIRES_REVIEW");
  assert.equal(ambiguous.contactCreated, false);
  const redirect = await inspectCampaignObservationEmail(fakeDb({
    observation: { ...entry, citationUrl:
      "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc" },
  }), scope, { retrieve });
  assert.equal(redirect.code, "DIRECT_PROFILE_SOURCE_REQUIRED");
  assert.equal(redirect.emailChecked, false);
  assert.equal(fetches, 0);
});

test("missing or ambiguous email remains research only", async () => {
  const result = await inspectCampaignObservationEmail(fakeDb(), scope, {
    retrieve: async () => ({ url: profile, text: "Name: Ada Expert. Contact page." }),
  });
  assert.equal(result.code, "ADDRESS_AMBIGUOUS_OR_NOT_PUBLISHED");
  assert.equal(result.contactCreated, false);
  assert.equal(result.emailChecked, true);
  assert.equal(result.observedEmail, undefined);
});

test("source mismatch and inspection failure do not promote an email", async () => {
  for (const retrieve of [
    async () => ({ ...page, url: "https://other.example.org" }),
    async () => { throw new Error("internal resolver failure"); },
  ]) {
    const result = await inspectCampaignObservationEmail(fakeDb(), scope, { retrieve });
    assert.equal(result.contactCreated, false);
    assert.equal(result.observedEmail, undefined);
    assert.equal(result.sendingEnabled, false);
  }
});

test("workspace membership revoked during public fetch prevents email disclosure", async () => {
  const db = fakeDb({ revoked: true });
  const result = await inspectCampaignObservationEmail(db, scope, {
    retrieve: async () => page,
  });
  assert.deepEqual(result, { status: 403, code: "WORKSPACE_ACCESS_REVOKED" });
});

test("invalid identifiers refuse work before any external fetch", async () => {
  await assert.rejects(
    () => inspectCampaignObservationEmail(fakeDb(), {
      ...scope, workspaceId: "other-workspace",
    }, { retrieve: async () => page }),
    TypeError);
});
