import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyExplicitPersonEmailPage, inspectAndStoreDirectEmailObservation,
  visibleDirectEmailObservation,
} from "../server/candidate-direct-email-evidence.js";

const url = "https://experts.example.org/ada";
const candidate = {
  id: "cmabcdefghijklmnopqrstu",
  name: "Ada Mentor", email: "ada.mentor@experts.example.org",
  expertProfileUrl: url,
};
const scope = {
  workspaceId: "cmabcdefghijklmnopqrstv",
  ownerId: "cmabcdefghijklmnopqrstw",
  candidateId: candidate.id,
};
const page = {
  url, text: "Name: Ada Mentor Expertise: AI and teaching Email: ada.mentor@experts.example.org",
};

test("labeled exact candidate profile is review-only, never a usable contact", () => {
  const result = classifyExplicitPersonEmailPage(candidate, page);
  assert.equal(result.status, "REVIEW_REQUIRED");
  assert.equal(result.reason, "EXPLICIT_NAMED_EMAIL_ON_PROFILE");
  assert.equal(result.emailNormalized, candidate.email);
  assert.equal(result.evidenceDigest.length, 64);
  assert.equal(result.personEmailLinked, false);
  assert.equal(result.usableAsContact, false);
  assert.equal(result.onboardingEligible, false);
});

test("mere proximity, generic inbox and ambiguous team pages cannot qualify", () => {
  for (const change of [
    { candidate: { ...candidate, expertProfileUrl: "https://other.example.org" }, page },
    { candidate, page: { ...page, text: "Ada Mentor | ada.mentor@experts.example.org" } },
    { candidate, page: { ...page, text: page.text + " Morgan contact@experts.example.org" } },
    { candidate, page: { ...page, text: "Name: Ada Mentor Email: support@experts.example.org" } },
    { candidate: { ...candidate, email: "info@experts.example.org" },
      page: { ...page, text: "Name: Ada Mentor Email: info@experts.example.org" } },
    { candidate, page: { url: "https://unknown.example.org", text: page.text } },
    { candidate, page: { ...page, text: "Email: ada.mentor@experts.example.org Name: Ada Mentor" } },
  ]) {
    assert.equal(classifyExplicitPersonEmailPage(change.candidate, change.page).status,
      "UNVERIFIED");
  }
});

function mock({ newEmail, newName, newProfile, revoked = false, shared = 0 } = {}) {
  const events = [];
  let persisted = null;
  const tx = {
    $queryRaw: async strings => {
      if (strings.join("?").includes('FROM "PartnerMembership"')) {
        events.push("membership");
        return revoked ? [{ revokedAt: new Date() }] : [{ revokedAt: null }];
      }
      events.push("candidate-lock");
      return [{ id: candidate.id, name: newName ?? candidate.name,
        email: newEmail ?? candidate.email,
        expertProfileUrl: newProfile ?? candidate.expertProfileUrl }];
    },
    candidate: { count: async () => { events.push("shared-check"); return shared; } },
    candidateDirectEmailObservation: {
      upsert: async entry => { events.push("save"); persisted = entry.create; },
    },
    auditEvent: { create: async data => {
      events.push("audit");
      assert.doesNotMatch(JSON.stringify(data), /ada.mentor@/);
    } },
  };
  return {
    events, getSaved: () => persisted,
    db: {
      candidate: { findFirst: async () => candidate },
      $transaction: cb => cb(tx),
    },
  };
}

test("server-inspected profile observation persists behind membership and row locks", async () => {
  const m = mock();
  const result = await inspectAndStoreDirectEmailObservation(m.db, scope, {
    retrieve: async input => {
      assert.equal(input, url);
      return page;
    },
    now: () => new Date("2026-11-16T16:00:00Z"),
  });
  assert.equal(result.status, 200);
  assert.equal(result.onboardingEligible, false);
  assert.deepEqual(m.events, ["membership", "candidate-lock", "shared-check", "save", "audit"]);
  assert.equal(m.getSaved().status, "REVIEW_REQUIRED");
  assert.equal(m.getSaved().emailNormalized, candidate.email);
  assert.equal(m.getSaved().personName, candidate.name);
});

test("revocation, changed candidate, shared URL fail closed without writing", async () => {
  for (const opts of [
    { revoked: true }, { newEmail: "morgan@example.org" },
    { newName: "Morgan Field" }, { newProfile: "https://new.example.org" },
    { shared: 1 },
  ]) {
    const m = mock(opts);
    const result = await inspectAndStoreDirectEmailObservation(m.db, scope, {
      retrieve: async () => page,
    });
    assert.notEqual(result.status, 200);
    assert.equal(m.getSaved(), null);
    assert.ok(!m.events.includes("audit"));
  }
});

test("unsafe or mismatched provider retrieval cannot generate persisted evidence", async () => {
  const m = mock();
  const result = await inspectAndStoreDirectEmailObservation(m.db, scope, {
    retrieve: async () => ({ url: "https://evil.example.org", text: page.text }),
  });
  assert.equal(result.status, 409);
  assert.equal(m.getSaved(), null);
});

test("evidence read view invalidates after email or profile changes", () => {
  const observation = { emailNormalized: candidate.email, personName: candidate.name,
    profileUrl: url, status: "REVIEW_REQUIRED",
    inspectedAt: new Date("2026-11-16T16:00:00Z") };
  assert.equal(visibleDirectEmailObservation(candidate, observation).usableAsContact, false);
  assert.equal(visibleDirectEmailObservation({ ...candidate,
    email: "new@example.org" }, observation), null);
  assert.equal(visibleDirectEmailObservation({ ...candidate,
    name: "Morgan Field" }, observation), null);
  assert.equal(visibleDirectEmailObservation({ ...candidate,
    expertProfileUrl: "https://new.example.org" }, observation), null);
  assert.equal(visibleDirectEmailObservation(candidate, {
    ...observation, status: "VERIFIED",
  }), null);
});
