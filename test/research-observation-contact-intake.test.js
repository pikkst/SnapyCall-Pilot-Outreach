import test from "node:test";
import assert from "node:assert/strict";
import { acceptReviewedCampaignContact }
  from "../server/research-observation-contact-intake.js";

const scope = {
  campaignId: "cmabcdefghijklmnopqrstu",
  observationId: "cmabcdefghijklmnopqrstv",
  workspaceId: "cmabcdefghijklmnopqrstw",
  ownerId: "cmabcdefghijklmnopqrstx",
  expectedDigest: "a".repeat(64),
  confirmsExactPersonEmailPair: true,
};
const observed = {
  status: 200, code: "NAMED_EMAIL_EVIDENCE_REVIEW_REQUIRED",
  name: "Ada Expert", category: "AI_AUTOMATION",
  observedEmail: "ada@experts.example.org",
  sourceUrl: "https://experts.example.org/ada",
  evidenceDigest: scope.expectedDigest, reviewRequired: true,
};

function fakeDb({ revoked = false, existing = null, changed = false,
  alreadyLinked = null, uniqueRace = false, grounding = false,
  shared = 0, sourceChanged = false } = {}) {
  const events = [];
  const created = { id: "cmcontactabcdefghijklmno" };
  const db = {
    partnerMembership: { findUnique: async () => ({}) },
    $transaction: async callback => callback({
      $queryRaw: async strings => {
        const sql = strings.join(" ");
        if (sql.includes('FROM "PartnerMembership"')) {
          events.push("membership-lock");
          return [{ revokedAt: revoked ? new Date() : null }];
        }
        if (sql.includes('FROM "ResearchCampaign"')) {
          events.push("campaign-lock");
          return [{ id: scope.campaignId }];
        }
        if (sql.includes('FROM "ResearchCampaignObservation"')) {
          events.push("observation-lock");
          return [{ id: scope.observationId,
            name: changed ? "Not Ada" : observed.name,
            category: observed.category,
            citationUrl: grounding
              ? "https://vertexaisearch.cloud.google.com/grounding-api-redirect/ABCDEFGH12345"
              : observed.sourceUrl,
            groundingStatus: grounding ? "SOURCE_HINT" : "UNCHECKED",
            groundingResolvedUrl: grounding
              ? (sourceChanged ? "https://other.example.org" : observed.sourceUrl)
              : null,
            groundingProvenance: grounding
              ? "GOOGLE_GROUNDING_LOCATION_HEADER" : null,
            candidateId: alreadyLinked }];
        }
        if (sql.includes('FROM "Partner"')) {
          events.push("workspace-lock");
          return [{ id: scope.workspaceId }];
        }
        throw new Error("Unexpected SQL: " + sql);
      },
      researchCampaignObservation: { count: async () => shared },
      candidate: {
        findFirst: async () => existing,
        create: async ({ data }) => {
          events.push("contact-create");
          assert.equal(data.name, observed.name);
          assert.equal(data.category, observed.category);
          assert.equal(data.email, observed.observedEmail);
          assert.equal(data.contactReviewed, false);
          assert.equal(data.profileReviewed, false);
          assert.equal(data.status, "REVIEW_PENDING");
          assert.equal(data.researchCitationUrl, grounding
            ? "https://vertexaisearch.cloud.google.com/grounding-api-redirect/ABCDEFGH12345"
            : observed.sourceUrl);
          if (uniqueRace) throw Object.assign(new Error("Duplicate"), { code: "P2002" });
          return created;
        },
      },
      candidateDirectEmailObservation: { create: async ({ data }) => {
        events.push("email-evidence");
        assert.equal(data.status, "PERSON_EMAIL_REVIEWED");
        assert.equal(data.reviewedBy, scope.ownerId);
        assert.equal(data.candidateId, created.id);
      } },
      candidateEvidence: { create: async ({ data }) => {
        events.push("profile-evidence");
        assert.equal(data.kind, "PROFILE");
      } },
      researchCampaignObservation: { updateMany: async ({ data }) => {
        events.push("observation-link");
        assert.equal(data.candidateId, created.id);
        return { count: 1 };
      } },
      auditEvent: { create: async ({ data }) => {
        events.push("audit");
        assert.equal(data.action, "research.campaign.reviewed-contact.created");
        assert.equal(JSON.stringify(data.metadata).includes("ada@"), false);
      } },
    }),
  };
  return { db, events, created };
}

test("explicit person-email review creates one review-only workspace contact and evidence", async () => {
  const { db, events, created } = fakeDb();
  const outcome = await acceptReviewedCampaignContact(db, scope, {
    inspect: async () => observed,
    now: () => new Date("2026-11-17T10:00:00Z"),
  });
  assert.equal(outcome.status, 201);
  assert.equal(outcome.candidateId, created.id);
  assert.equal(outcome.contactCreated, true);
  assert.equal(outcome.onboardingEligible, false);
  assert.equal(outcome.sendingEnabled, false);
  assert.deepEqual(events, ["membership-lock", "campaign-lock", "observation-lock",
    "workspace-lock", "contact-create", "email-evidence", "profile-evidence",
    "observation-link", "audit"]);
});

test("resolved public source yields a contact with original Gemini citation preserved", async () => {
  const { db, events } = fakeDb({ grounding: true });
  const result = await acceptReviewedCampaignContact(db, scope, {
    inspect: async () => observed,
  });
  assert.equal(result.code, "CONTACT_CREATED_REVIEW_PENDING");
  assert.equal(result.sendingEnabled, false);
  assert.ok(events.includes("contact-create"));
});

test("changed resolved URL and shared destination block contact creation", async () => {
  for (const opts of [{ grounding: true, sourceChanged: true },
    { grounding: true, shared: 1 }]) {
    const { db, events } = fakeDb(opts);
    const outcome = await acceptReviewedCampaignContact(db, scope, {
      inspect: async () => observed,
    });
    assert.equal(outcome.status, 409);
    assert.equal(events.includes("contact-create"), false);
  }
});

test("no email or mismatched digest cannot create a contact", async () => {
  for (const inspection of [
    { ...observed, code: "ADDRESS_AMBIGUOUS_OR_NOT_PUBLISHED",
      observedEmail: undefined },
    { ...observed, evidenceDigest: "b".repeat(64) },
    { ...observed, observedEmail: "" },
    { ...observed, observedEmail: "info@experts.example.org", evidenceDigest: "" },
  ]) {
    const { db, events } = fakeDb();
    const result = await acceptReviewedCampaignContact(db, scope, {
      inspect: async () => inspection,
    });
    assert.equal(result.status, 409);
    assert.equal(result.contactCreated, false);
    assert.deepEqual(events, []);
  }
});

test("missing explicit review confirmation fails before inspection", async () => {
  const { db } = fakeDb();
  let calls = 0;
  await assert.rejects(() => acceptReviewedCampaignContact(db, {
    ...scope, confirmsExactPersonEmailPair: false,
  }, { inspect: async () => { calls++; return observed; } }), TypeError);
  assert.equal(calls, 0);
});

test("review transaction refuses revocation and changed source binding", async () => {
  for (const options of [{ revoked: true }, { changed: true }]) {
    const { db, events } = fakeDb(options);
    const result = await acceptReviewedCampaignContact(db, scope, {
      inspect: async () => observed,
    });
    assert.ok([403, 409].includes(result.status));
    assert.equal(result.contactCreated, false);
    assert.equal(events.includes("contact-create"), false);
  }
});

test("existing candidate email collision never silently reattaches an identity", async () => {
  const existing = { id: "cmotherabcdefghijklmno", name: observed.name,
    category: observed.category, emailNormalized: observed.observedEmail,
    expertProfileUrl: observed.sourceUrl };
  const { db, events } = fakeDb({ existing });
  const result = await acceptReviewedCampaignContact(db, scope, {
    inspect: async () => observed,
  });
  assert.equal(result.code, "CONTACT_IDENTITY_COLLISION");
  assert.equal(events.includes("contact-create"), false);
});

test("exactly linked accepted contact allows idempotent replay without edits", async () => {
  const existing = { id: "cmcontactabcdefghijklmno", name: observed.name,
    category: observed.category, emailNormalized: observed.observedEmail,
    expertProfileUrl: observed.sourceUrl };
  const { db, events } = fakeDb({ existing, alreadyLinked: existing.id });
  const result = await acceptReviewedCampaignContact(db, scope, {
    inspect: async () => observed,
  });
  assert.equal(result.code, "CONTACT_ALREADY_LINKED");
  assert.equal(result.contactCreated, false);
  assert.equal(result.candidateId, existing.id);
  assert.equal(events.includes("contact-create"), false);
});

test("database unique collision fails closed without pretending success", async () => {
  const { db } = fakeDb({ uniqueRace: true });
  const result = await acceptReviewedCampaignContact(db, scope, {
    inspect: async () => observed,
  });
  assert.equal(result.status, 409);
  assert.equal(result.code, "CONTACT_IDENTITY_COLLISION");
  assert.equal(result.contactCreated, false);
});
