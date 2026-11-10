import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCandidate, scoreCandidate, outreachDecision, EXPERT_CATEGORIES } from "../src/domain.js";

const candidate = {
  name: "Example Expert",
  category: "AI_AUTOMATION",
  sourceUrl: "https://example.org/experts/123",
  email: "EXPERT@example.org",
  region: "US",
  onlineEnglish: true,
};

test("category allocations total 100", () => {
  assert.equal(Object.values(EXPERT_CATEGORIES).reduce((a, b) => a + b, 0), 100);
});
test("normalizes valid candidate without touching external services", () => {
  const result = normalizeCandidate(candidate);
  assert.equal(result.email, "expert@example.org");
  assert.ok(Object.isFrozen(result));
});
test("rejects unknown category, malformed input, and unsafe provenance URLs", () => {
  assert.throws(() => normalizeCandidate({ ...candidate, category: "OTHER" }));
  assert.throws(() => normalizeCandidate({ ...candidate, sourceUrl: "file:///etc/passwd" }));
  assert.throws(() => normalizeCandidate({ ...candidate, sourceUrl: "http://localhost/private" }));
  assert.throws(() => normalizeCandidate({ ...candidate, sourceUrl: "http://127.0.0.1/private" }));
  assert.throws(() => normalizeCandidate({ ...candidate, email: "invalid" }));
  assert.throws(() => normalizeCandidate({ ...candidate, name: 42 }));
});
test("english online requirement is mandatory; geography is not a hard filter", () => {
  assert.equal(scoreCandidate({ ...candidate, onlineEnglish: false }).eligible, false);
  assert.equal(scoreCandidate({ ...candidate, region: "UNKNOWN" }).eligible, true);
  assert.equal(scoreCandidate(candidate).score, 70);
});
test("public contact details do not authorize sending", () => {
  const result = outreachDecision(candidate);
  assert.equal(result.canDraft, true);
  assert.equal(result.canSend, false);
  assert.deepEqual(result.blockers, ["legal_basis_missing", "contact_review_pending"]);
});
test("suppressed contacts remain blocked even after review", () => {
  const result = outreachDecision({ ...candidate, contactReviewed: true, legalBasis: "legitimate_interest_reviewed", suppressed: true });
  assert.equal(result.canSend, false);
  assert.deepEqual(result.blockers, ["suppressed"]);
});
