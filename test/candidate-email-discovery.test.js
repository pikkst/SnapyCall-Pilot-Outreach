import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyExplicitPersonEmailPage, inspectAndStoreDirectEmailObservation,
  visibleDirectEmailObservation,
} from "../server/candidate-direct-email-evidence.js";
import {
  reviewCandidateDirectEmailEvidence, directEmailReviewSnapshot,
} from "../server/candidate-direct-email-review.js";

const scope = {
  workspaceId: "cmabcdefghijklmnopqrstv",
  ownerId: "cmabcdefghijklmnopqrstw",
  candidateId: "cmabcdefghijklmnopqrstu",
};
const now = new Date("2026-11-16T17:00:00Z");
const url = "https://experts.example.org/ada";
const email = "ada.mentor@experts.example.org";
const person = {
  id: scope.candidateId, name: "Ada Mentor", email: null,
  expertProfileUrl: url, suppressed: false,
};
const page = { url, text: "Name: Ada Mentor — AI Consultant Email: " + email };

function dbMock({ initial = person, live = initial, revoked = false,
  shared = 0, collision = false, evidence = null } = {}) {
  let row = { ...live };
  const log = [];
  const observation = evidence ? { ...evidence } : null;
  const tx = {
    $queryRaw: async strings => {
      if (strings.join("?").includes('FROM "PartnerMembership"')) {
        log.push("membership-lock");
        return [{ revokedAt: revoked ? now : null }];
      }
      log.push("candidate-lock");
      return [{ ...row }];
    },
    candidate: {
      count: async () => { log.push("shared-check"); return shared; },
      update: async ({ where, data }) => {
        log.push("email-bind");
        assert.equal(where.id, scope.candidateId);
        if (collision) throw Object.assign(new Error("duplicate"), { code: "P2002" });
        Object.assign(row, data);
        return row;
      },
    },
    candidateDirectEmailObservation: {
      upsert: async ({ create }) => {
        log.push("observation-write");
        Object.assign(observation ?? {}, create);
        tx.observed = create;
      },
      findUnique: async () => observation ?? tx.observed ?? null,
      updateMany: async ({ data }) => {
        log.push("review-write");
        Object.assign(observation ?? tx.observed, data);
        return { count: 1 };
      },
    },
    auditEvent: {
      create: async ({ data }) => {
        log.push("audit");
        assert.doesNotMatch(JSON.stringify(data), /ada\.mentor@experts/);
      },
    },
    observed: null,
  };
  return {
    log, current: () => row, evidence: () => observation ?? tx.observed,
    db: {
      candidate: { findFirst: async () => initial },
      $transaction: callback => callback(tx),
    },
  };
}

test("an expert WITHOUT a saved email yields a review-only cited profile observation", async () => {
  const finding = classifyExplicitPersonEmailPage(person, page);
  assert.equal(finding.status, "REVIEW_REQUIRED");
  assert.equal(finding.emailNormalized, email);
  assert.equal(finding.personEmailLinked, false);
  const f = dbMock();
  const out = await inspectAndStoreDirectEmailObservation(f.db, scope, {
    retrieve: async input => { assert.equal(input, url); return page; },
    now: () => now,
  });
  assert.equal(out.status, 200);
  assert.equal(out.usableAsContact, false);
  assert.equal(f.evidence().emailNormalized, email);
  assert.equal(f.current().email, null);
  assert.equal(f.log.includes("email-bind"), false);
  const preview = directEmailReviewSnapshot(person, f.evidence(), now);
  assert.equal(preview.observedEmail, email);
  assert.equal(preview.reviewRequired, true);
  assert.equal(preview.personEmailLinked, false);
});

test("explicit reviewer attestation alone binds extracted email transactionally", async () => {
  const f = dbMock({ evidence: {
    workspaceId: scope.workspaceId, candidateId: scope.candidateId,
    personName: person.name, emailNormalized: email, profileUrl: url,
    status: "REVIEW_REQUIRED", inspectedAt: now,
    evidenceDigest: "b".repeat(64), reviewedAt: null, reviewedBy: null,
  } });
  const out = await reviewCandidateDirectEmailEvidence(f.db, {
    ...scope, expectedDigest: "b".repeat(64),
  }, { now: () => new Date(now.getTime() + 1000) });
  assert.equal(out.status, 200);
  assert.equal(out.personEmailLinked, true);
  assert.equal(out.usableAsContact, false);
  assert.equal(out.onboardingEligible, false);
  assert.equal(f.current().email, email);
  assert.equal(f.current().emailNormalized, email);
  assert.deepEqual(f.log, ["membership-lock", "candidate-lock", "email-bind",
    "review-write", "audit"]);
  assert.equal(visibleDirectEmailObservation(f.current(), f.evidence(),
    new Date(now.getTime() + 1000)).personEmailLinked, true);
});

test("duplicate workspace email returns conflict and never marks evidence reviewed", async () => {
  const f = dbMock({ collision: true, evidence: {
    workspaceId: scope.workspaceId, candidateId: scope.candidateId,
    personName: person.name, emailNormalized: email, profileUrl: url,
    status: "REVIEW_REQUIRED", inspectedAt: now,
    evidenceDigest: "b".repeat(64),
  } });
  const out = await reviewCandidateDirectEmailEvidence(f.db, {
    ...scope, expectedDigest: "b".repeat(64),
  }, { now: () => new Date(now.getTime() + 1000) });
  assert.equal(out.status, 409);
  assert.equal(out.code, "EMAIL_ALREADY_ASSIGNED_IN_WORKSPACE");
  assert.equal(f.log.includes("review-write"), false);
  assert.equal(f.log.includes("audit"), false);
});

test("the page cannot override a different preexisting email, or changed in-flight candidate", async () => {
  assert.equal(classifyExplicitPersonEmailPage({
    ...person, email: "morgan@example.org",
  }, page).status, "UNVERIFIED");
  for (const options of [
    { live: { ...person, email: "morgan@example.org" } },
    { live: { ...person, name: "Morgan" } },
    { live: { ...person, expertProfileUrl: "https://experts.example.org/other" } },
    { revoked: true },
    { shared: 1 },
  ]) {
    const f = dbMock(options);
    const out = await inspectAndStoreDirectEmailObservation(f.db, scope, {
      retrieve: async () => page, now: () => now,
    });
    assert.notEqual(out.status, 200);
    assert.equal(f.log.includes("observation-write"), false);
  }
});

test("unlabeled, generic and multi-mailbox pages never discover a usable address", () => {
  for (const source of [
    "Ada Mentor " + email,
    "Name: Ada Mentor Email: info@experts.example.org",
    page.text + " General: info@experts.example.org",
    "Name: Ada Mentor Email: " + email + " Other: morgan@example.org",
    "Email: " + email + " Name: Ada Mentor",
  ]) {
    assert.equal(classifyExplicitPersonEmailPage(person,
      { url, text: source }).status, "UNVERIFIED");
  }
});
