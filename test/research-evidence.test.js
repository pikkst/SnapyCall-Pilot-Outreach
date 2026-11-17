import test from "node:test";
import assert from "node:assert/strict";
import { buildBoundedRetrievalManifest, normalizeBoundedRetrievalEvidence, normalizeResearchEvidence, publicCitationUrl } from "../server/research-evidence.js";

const url = "https://profiles.example.org/consultant";
const candidate = {
  name: "Independent Expert", category: "AI_AUTOMATION",
  sourceUrl: url, rationale: "Provider-cited evidence of a professional consulting profile",
};
const evidence = (candidates, citations = [{ url, title: "Independent profile" }]) =>
  normalizeResearchEvidence({ text: JSON.stringify({ candidates }), citations, limit: 10 });

test("shared contract accepts exact provider citation and keeps contacts unverified", () => {
  const result = evidence([candidate]);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].email, null);
  assert.equal(result.candidates[0].contactReviewed, false);
  assert.equal(result.candidates[0].status, "REVIEW_PENDING");
  assert.deepEqual(result.sources, [{ url, title: "Independent profile" }]);
});

test("no source can be elevated from model-authored JSON alone", () => {
  assert.deepEqual(evidence([candidate], []).candidates, []);
  assert.deepEqual(evidence([candidate], [{ url: "https://other.example.org" }]).candidates, []);
  assert.deepEqual(evidence([{ ...candidate, email: "invented@example.org" }]).candidates, []);
  assert.deepEqual(evidence([{ ...candidate, contactReviewed: true }]).candidates, []);
});

test("canonicalization prevents fragment duplicates, and refuses private or ambiguous URLs", () => {
  const result = evidence([
    candidate, { ...candidate, sourceUrl: url + "#bio" },
  ]);
  assert.equal(result.candidates.length, 1);
  for (const unsafe of [
    "http://profiles.example.org/consultant",
    "https://localhost/a", "https://foo.local/path",
    "https://127.0.0.1/a", "https://[::1]/a",
    "https://foo.internal/path", "https://foo.invalid/path",
    "https://me:secret@profiles.example.org/path",
    "https://profiles.example.org:444/path",
  ]) assert.equal(publicCitationUrl(unsafe), null, unsafe);
});

test("contract rejects malformed or unbounded responses, preserving failed-closed behavior", () => {
  assert.throws(() => normalizeResearchEvidence({ text: "Not JSON", citations: [{ url }], limit: 10 }));
  assert.throws(() => normalizeResearchEvidence({
    text: JSON.stringify({ candidates: Array(21).fill(candidate) }),
    citations: [{ url }], limit: 10,
  }));
  assert.throws(() => normalizeResearchEvidence({ text: "{}", citations: [], limit: 21 }));
  assert.throws(() => normalizeResearchEvidence({
    text: "{}",
    citations: Array(201).fill({ url }), limit: 10,
  }));
});

test("shared normalization is deterministic across provider-specific citation sources", () => {
  const claude = evidence([candidate], [{ url, title: "Claude citation" }]);
  const openai = evidence([candidate], [{ url, title: "OpenAI URL annotation" }]);
  const gemini = evidence([candidate], [{ url, title: "Gemini grounding chunk" }]);
  assert.deepEqual(claude.candidates, openai.candidates);
  assert.deepEqual(openai.candidates, gemini.candidates);
});


test("uncited model URLs are discarded and the operator sees the exclusion count", () => {
  const extra = { ...candidate, name: "Unverified Person",
    sourceUrl: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/model-only" };
  const result = evidence([candidate, extra]);
  assert.deepEqual(result.candidates.map(c => c.name), ["Independent Expert"]);
  assert.match(result.warnings.join(" "), /1 AI suggestions were not accepted/);
  assert.equal(result.candidates[0].email, null);
});


const boundedRecord = {
  sourceId: "doc-01",
  url: "https://profiles.example.org/consultant#bio",
  title: "Independent profile",
  excerpt: "Publicly described AI automation consultancy",
};
const manifest = records => buildBoundedRetrievalManifest({
  provider: "synthetic_test",
  observedAt: "2026-11-18T00:00:00.000Z",
  records,
});

test("bounded manifest is order-independent, immutable and binds exact source text", () => {
  const second = {
    sourceId: "doc-02", url: "https://another.example.org/a",
    title: "Second source", excerpt: "Professional profile corroboration",
  };
  const first = manifest([boundedRecord, second]);
  const reordered = manifest([second, boundedRecord]);
  assert.deepEqual(first, reordered);
  assert.match(first.digest, /^[a-f0-9]{64}$/);
  assert.equal(first.records[0].sourceId, "doc-01");
  assert.equal(first.records[0].url, "https://profiles.example.org/consultant");
  assert.equal(first.records[0].sourceProvider, "synthetic_test");
  assert.equal(Object.isFrozen(first.records[0]), true);
  assert.notEqual(manifest([{ ...boundedRecord, excerpt: "Edited profile" }, second]).digest, first.digest);
  assert.notEqual(buildBoundedRetrievalManifest({
    provider: "different", observedAt: "2026-11-18T00:00:00.000Z",
    records: [boundedRecord, second],
  }).digest, first.digest);
});

test("bounded manifest fails closed for ambiguous or malformed retrieval records", () => {
  for (const records of [
    [], Array(21).fill(boundedRecord),
    [boundedRecord, boundedRecord],
    [{ ...boundedRecord, sourceId: "../path" }],
    [{ ...boundedRecord, url: "https://127.0.0.1/private" }],
    [{ ...boundedRecord, url: "http://profiles.example.org/a" }],
    [{ ...boundedRecord, url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc" }],
    [{ ...boundedRecord, title: "" }],
    [{ ...boundedRecord, excerpt: "x".repeat(1501) }],
  ]) assert.throws(() => manifest(records), TypeError);
  assert.throws(() => buildBoundedRetrievalManifest({
    provider: "synthetic_test", observedAt: "not-a-time", records: [boundedRecord],
  }), TypeError);
});

const boundedCandidate = {
  name: "Independent Expert", category: "AI_AUTOMATION",
  sourceId: "doc-01", rationale: "Referenced public professional profile",
};
const bind = (items, data = manifest([boundedRecord])) =>
  normalizeBoundedRetrievalEvidence({
    text: JSON.stringify({ candidates: items }),
    manifest: data, limit: 10,
  });

test("model source IDs resolve only through the verified retrieval manifest", () => {
  const data = manifest([boundedRecord]);
  const result = bind([boundedCandidate], data);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].sourceUrl, "https://profiles.example.org/consultant");
  assert.equal(result.candidates[0].email, null);
  assert.equal(result.candidates[0].contactReviewed, false);
  assert.equal(result.candidates[0].status, "REVIEW_PENDING");
  assert.equal(result.manifestDigest, data.digest);
  assert.equal(result.imported, false);
  assert.equal(result.reviewRequired, true);
  assert.equal(result.sendingEnabled, false);
});

test("unknown sources and fabricated model URLs cannot become cited candidates", () => {
  const forged = [
    { ...boundedCandidate, sourceId: "not-in-retrieval" },
    { ...boundedCandidate, sourceUrl: "https://invented.example.org/" },
    { ...boundedCandidate, email: "madeup@example.org" },
    { ...boundedCandidate, profileReviewed: true },
  ];
  const result = bind(forged);
  assert.equal(result.candidates.length, 0);
  assert.ok(result.warnings.length > 0);
  assert.equal(result.sources.length, 1);
});

test("a modified or mixed-provenance manifest is rejected before normalization", () => {
  const original = manifest([boundedRecord]);
  for (const tampered of [
    { ...original, digest: "0".repeat(64) },
    { ...original, records: [{ ...original.records[0], excerpt: "Altered text" }] },
    { ...original, records: [{ ...original.records[0], sourceProvider: "other" }] },
    { ...original, records: [{ ...original.records[0], sourceId: "elsewhere" }] },
  ]) assert.throws(() => bind([boundedCandidate], tampered), TypeError);
});

test("bounded model output rejects malformed and oversized candidate envelopes", () => {
  const data = manifest([boundedRecord]);
  for (const text of ["not json", "{}", JSON.stringify({
    candidates: Array(21).fill(boundedCandidate),
  })]) assert.throws(() => normalizeBoundedRetrievalEvidence({
    text, manifest: data, limit: 10,
  }));
  assert.throws(() => normalizeBoundedRetrievalEvidence({
    text: JSON.stringify({ candidates: [boundedCandidate] }),
    manifest: data, limit: 21,
  }), TypeError);
});
