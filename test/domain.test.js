import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCandidate, scoreCandidate, outreachDecision, qualificationDecision,
  QUALIFICATION_STAGES, EXPERT_CATEGORIES, REGION_PRIORITIES,
} from "../src/domain.js";

const candidate = {
  name: "Example Expert", category: "AI_AUTOMATION",
  sourceUrl: "https://example.org/experts/123", email: "EXPERT@example.org",
  region: "US", onlineEnglish: true,
};

test("campaign category and region targets are independent 100% allocations", () => {
  assert.equal(Object.values(EXPERT_CATEGORIES).reduce((a, b) => a + b, 0), 100);
  assert.equal(Object.values(REGION_PRIORITIES).reduce((a, b) => a + b, 0), 100);
});

test("normalizes candidate without network calls and rejects unsafe input", () => {
  const result = normalizeCandidate(candidate);
  assert.equal(result.email, "expert@example.org");
  assert.ok(Object.isFrozen(result));
  for (const change of [
    { category: "OTHER" }, { sourceUrl: "file:///etc/passwd" },
    { sourceUrl: "http://localhost/private" }, { sourceUrl: "http://127.0.0.1/private" },
    { email: "invalid" }, { name: 42 }, { expertProfileUrl: "file:///etc/passwd" },
  ]) assert.throws(() => normalizeCandidate({ ...candidate, ...change }));
});

test("region and category do not determine suitability or numeric merit", () => {
  const original = scoreCandidate(candidate);
  assert.equal(original.eligible, true);
  assert.equal(original.score, null);
  for (const category of Object.keys(EXPERT_CATEGORIES)) {
    for (const region of [...Object.keys(REGION_PRIORITIES), null]) {
      const q = scoreCandidate({ ...candidate, category, region });
      assert.equal(q.eligible, true);
      assert.equal(q.score, null);
      assert.deepEqual(q.reasons, ["legal_basis_missing", "contact_review_pending"]);
    }
  }
});

test("untouched RSS byline is discovered but never qualified", () => {
  const imported = {
    ...candidate, discoveryKey: "a".repeat(64), onlineEnglish: false,
    email: null, status: "REVIEW_PENDING",
  };
  const q = qualificationDecision(imported);
  assert.equal(q.stage, QUALIFICATION_STAGES.DISCOVERED);
  assert.equal(q.qualified, false);
  assert.equal(q.score, null);
  assert.deepEqual(q.blockers, [
    "english_online_requirement_unconfirmed", "expert_profile_review_pending",
  ]);
  assert.equal(outreachDecision(imported).canDraft, false);
  assert.ok(Object.isFrozen(q.blockers));
});

test("partial RSS evidence remains pending even if English is checked", () => {
  const imported = { ...candidate, discoveryKey: "b".repeat(64), status: "REVIEW_PENDING" };
  const q = qualificationDecision(imported);
  assert.equal(q.stage, QUALIFICATION_STAGES.EVIDENCE_PENDING);
  assert.equal(q.qualified, false);
  assert.deepEqual(q.blockers, ["expert_profile_review_pending"]);
  assert.equal(outreachDecision(imported).canDraft, false);
});

test("reviewed profile qualifies independently of contact permission", () => {
  const qualified = {
    ...candidate, discoveryKey: "c".repeat(64),
    expertProfileUrl: "https://consultants.example.org/expert",
    profileReviewed: true, email: null, status: "REVIEWED",
  };
  assert.equal(qualificationDecision(qualified).stage, QUALIFICATION_STAGES.QUALIFIED);
  assert.equal(qualificationDecision(qualified).qualified, true);
  assert.equal(outreachDecision(qualified).canDraft, false);
  assert.deepEqual(outreachDecision(qualified).blockers, [
    "email_missing", "legal_basis_missing", "contact_review_pending",
  ]);
});

test("contact in review is distinct from approved draft", () => {
  assert.equal(qualificationDecision(candidate).stage, QUALIFICATION_STAGES.CONTACT_REVIEW);
  assert.equal(outreachDecision(candidate).canDraft, false);
  const ready = { ...candidate, contactReviewed: true, legalBasis: "reviewed_business_contact" };
  assert.equal(qualificationDecision(ready).stage, QUALIFICATION_STAGES.DRAFT_READY);
  assert.equal(outreachDecision(ready).canDraft, true);
  assert.equal(outreachDecision(ready).canSend, false);
  assert.deepEqual(outreachDecision(ready).blockers, []);
});

test("suppression and rejection override all review flags", () => {
  const ready = { ...candidate, contactReviewed: true, legalBasis: "reviewed_business_contact" };
  for (const input of [
    { ...ready, suppressed: true },
    { ...ready, status: "REJECTED" },
    { ...ready, status: "DISQUALIFIED" },
  ]) {
    assert.equal(qualificationDecision(input).qualified, false);
    assert.equal(outreachDecision(input).canDraft, false);
    assert.equal(outreachDecision(input).canSend, false);
  }
  assert.equal(qualificationDecision({ ...ready, suppressed: true }).stage, QUALIFICATION_STAGES.SUPPRESSED);
  assert.equal(qualificationDecision({ ...ready, status: "REJECTED" }).stage, QUALIFICATION_STAGES.REJECTED);
});

test("manually added historical records remain readable and follow evidence checks", () => {
  assert.equal(qualificationDecision(candidate).qualified, true);
  assert.equal(outreachDecision(candidate).canDraft, false);
  assert.equal(qualificationDecision({ ...candidate, onlineEnglish: false }).stage,
    QUALIFICATION_STAGES.EVIDENCE_PENDING);
  assert.equal(scoreCandidate({ ...candidate, region: "UNKNOWN" }).eligible, true);
});

test("a review flag without a valid professional profile cannot qualify RSS lead", () => {
  const imported = { ...candidate, discoveryKey: "d".repeat(64), profileReviewed: true };
  assert.equal(scoreCandidate(imported).eligible, false);
  assert.equal(outreachDecision(imported).canDraft, false);
  assert.throws(() => normalizeCandidate({
    ...imported, expertProfileUrl: "http://localhost/private",
  }));
});
