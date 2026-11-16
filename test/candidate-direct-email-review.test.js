import test from "node:test";
import assert from "node:assert/strict";
import { reviewCandidateDirectEmailEvidence, directEmailReviewSnapshot
} from "../server/candidate-direct-email-review.js";

const ids = {
  candidateId: "cmabcdefghijklmnopqrstu",
  workspaceId: "cmabcdefghijklmnopqrstv",
  ownerId: "cmabcdefghijklmnopqrstw",
};
const at = new Date("2026-11-16T16:00:00Z");
const clock = { now: () => new Date("2026-11-16T17:00:00Z") };
const digest = "b".repeat(64);
const url = "https://experts.example.org/ada";
const candidate = { id: ids.candidateId, name: "Ada Mentor",
  email: "ada@example.org", expertProfileUrl: url, suppressed: false };
const observation = { candidateId: ids.candidateId,
  workspaceId: ids.workspaceId, personName: "Ada Mentor",
  emailNormalized: "ada@example.org", profileUrl: url,
  evidenceDigest: digest, status: "REVIEW_REQUIRED", inspectedAt: at,
  reviewedAt: null, reviewedBy: null,
};

function fixture({ revoked = false, candidateChanges = {}, evidenceChanges = {} } = {}) {
  const events = [];
  const item = { ...observation, ...evidenceChanges };
  const current = { ...candidate, ...candidateChanges };
  const tx = {
    $queryRaw: async strings => {
      if (strings.join("?").includes('FROM "PartnerMembership"')) {
        events.push("membership");
        return [{ revokedAt: revoked ? at : null }];
      }
      events.push("candidate-lock");
      return [current];
    },
    candidateDirectEmailObservation: {
      findUnique: async () => item,
      updateMany: async ({ where, data }) => {
        events.push("review-write");
        assert.equal(where.evidenceDigest, digest);
        Object.assign(item, data);
        return { count: 1 };
      },
    },
    auditEvent: { create: async ({ data }) => {
      events.push("audit");
      assert.doesNotMatch(JSON.stringify(data), /ada@example.org/);
    } },
  };
  return { events, item, db: { $transaction: fn => fn(tx) } };
}

test("a human review attests exact evidence but cannot enable onboarding", async () => {
  const f = fixture();
  const out = await reviewCandidateDirectEmailEvidence(f.db,
    { ...ids, expectedDigest: digest }, clock);
  assert.equal(out.status, 200);
  assert.equal(out.code, "PERSON_EMAIL_REVIEWED");
  assert.equal(out.personEmailLinked, true);
  assert.equal(out.usableAsContact, false);
  assert.equal(out.onboardingEligible, false);
  assert.equal(out.sendingEnabled, false);
  assert.deepEqual(f.events, ["membership", "candidate-lock", "review-write", "audit"]);
  assert.equal(f.item.reviewedBy, ids.ownerId);
  const snap = directEmailReviewSnapshot(candidate, f.item, clock.now());
  assert.equal(snap.personEmailLinked, true);
  assert.equal(snap.reviewRequired, false);
});

test("same digest reviewed twice is idempotent without another audit", async () => {
  const f = fixture({ evidenceChanges: {
    status: "PERSON_EMAIL_REVIEWED", reviewedAt: clock.now(),
    reviewedBy: ids.ownerId,
  } });
  const out = await reviewCandidateDirectEmailEvidence(f.db,
    { ...ids, expectedDigest: digest }, clock);
  assert.equal(out.code, "PERSON_EMAIL_REVIEW_UNCHANGED");
  assert.ok(!f.events.includes("review-write"));
  assert.ok(!f.events.includes("audit"));
});

test("revoked membership, suppressed person or changed evidence cannot be reviewed", async () => {
  for (const params of [
    { revoked: true },
    { candidateChanges: { suppressed: true } },
    { candidateChanges: { email: "morgan@example.org" } },
    { candidateChanges: { name: "Morgan Expert" } },
    { candidateChanges: { expertProfileUrl: "https://other.example.org" } },
    { evidenceChanges: { evidenceDigest: "c".repeat(64) } },
    { evidenceChanges: { inspectedAt: new Date("2025-01-01T00:00:00Z") } },
    { evidenceChanges: { workspaceId: "cmotherotherotherotherother" } },
  ]) {
    const f = fixture(params);
    const out = await reviewCandidateDirectEmailEvidence(f.db,
      { ...ids, expectedDigest: digest }, clock);
    assert.notEqual(out.status, 200, JSON.stringify(params));
    assert.ok(!f.events.includes("review-write"));
  }
});

test("stale or changed profile never shows reviewed identity as usable contact", () => {
  const v = { ...observation, status: "PERSON_EMAIL_REVIEWED",
    reviewedAt: clock.now(), reviewedBy: ids.ownerId };
  assert.equal(directEmailReviewSnapshot(candidate, v, clock.now()).personEmailLinked, true);
  assert.equal(directEmailReviewSnapshot({ ...candidate,
    name: "Morgan" }, v, clock.now()), null);
  assert.equal(directEmailReviewSnapshot(candidate, v,
    new Date("2026-12-01T00:00:00Z")), null);
  assert.equal(directEmailReviewSnapshot(candidate, {
    ...v, status: "REVIEW_REQUIRED", reviewedAt: null, reviewedBy: null,
  }, clock.now()).personEmailLinked, false);
});

test("malformed stored reviewer attestation cannot be replayed as linked", async () => {
  const f = fixture({ evidenceChanges: {
    status: "PERSON_EMAIL_REVIEWED", reviewedAt: null, reviewedBy: null,
  } });
  const out = await reviewCandidateDirectEmailEvidence(f.db,
    { ...ids, expectedDigest: digest }, clock);
  assert.equal(out.status, 409);
  assert.equal(out.code, "REVIEW_ATTESTATION_INVALID");
  assert.ok(!f.events.includes("review-write"));
});
