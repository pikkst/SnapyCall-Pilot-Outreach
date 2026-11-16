import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDiscoveryLeadSeed } from "../server/discovery-lead-seed.js";
import { normalizeCandidate, qualificationDecision, outreachDecision } from "../src/domain.js";
import { selectedDiscoverySeedBatch, reviewedCandidateKey } from "../src/research-review-batch.js";

const opaque = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque";
const valid = "https://company.example.org/experts";

test("Gemini citation queues candidate with no fabricated durable source", () => {
  const request = { discoverySeed: true, name: "Ada Mentor", category: "COACHING", citationUrl: opaque };
  const seed = normalizeDiscoveryLeadSeed(request);
  assert.equal(seed.sourceUrl, null);
  assert.equal(seed.researchCitationUrl, opaque);
  assert.equal(seed.discoveryKey.length, 64);
  assert.deepEqual(seed, normalizeDiscoveryLeadSeed(request));
  const candidate = normalizeCandidate({ ...seed, discoverySeed: true });
  assert.equal(candidate.sourceUrl, null);
  const persisted = { ...candidate, discoveryKey: seed.discoveryKey, status: "REVIEW_PENDING" };
  assert.equal(qualificationDecision(persisted).qualified, false);
  assert.equal(outreachDecision(persisted).canDraft, false);
  assert.equal(outreachDecision(persisted).canSend, false);
});

test("general public citation is not proof of person-level email or permission", () => {
  const seed = normalizeDiscoveryLeadSeed({
    discoverySeed: true, name: "Ben Expert", category: "AI_AUTOMATION", citationUrl: valid,
  });
  assert.equal(seed.sourceUrl, valid);
  const candidate = normalizeCandidate({ ...seed, discoverySeed: true });
  assert.equal(candidate.email, null);
  assert.equal(candidate.contactReviewed, false);
  assert.equal(candidate.profileReviewed, false);
  assert.equal(candidate.legalBasis, null);
});

test("batch intake selects all without per-row review, skips saved, and is bounded", () => {
  const candidates = [
    { name: "Ada Mentor", category: "COACHING", sourceUrl: opaque },
    { name: "Ben Expert", category: "AI_AUTOMATION", sourceUrl: valid },
  ];
  const keys = candidates.map(reviewedCandidateKey);
  const batch = selectedDiscoverySeedBatch(candidates, keys, []);
  assert.deepEqual(batch.map(x => x.discoverySeed), [true, true]);
  assert.deepEqual(batch.map(x => x.citationUrl), [opaque, valid]);
  assert.deepEqual(selectedDiscoverySeedBatch(candidates, keys, [keys[0]]).map(x => x.name), ["Ben Expert"]);
  assert.deepEqual(selectedDiscoverySeedBatch(candidates, [], []), []);
  assert.deepEqual(selectedDiscoverySeedBatch(Array(21).fill(candidates[0]), keys, []), []);
});

test("unsafe sources and forged approval are rejected; manual intake stays strict", () => {
  const seed = { discoverySeed: true, name: "Ada Mentor",
    category: "COACHING", citationUrl: "http://localhost/secret" };
  assert.throws(() => normalizeDiscoveryLeadSeed(seed));
  assert.throws(() => normalizeDiscoveryLeadSeed({ ...seed, citationUrl: opaque,
    email: "contact@example.org" }));
  assert.throws(() => normalizeCandidate({ name: "Ada Mentor", category: "COACHING" }));
  assert.throws(() => normalizeCandidate({ name: "Ada Mentor", category: "COACHING",
    status: "REVIEW_PENDING" }));
});
