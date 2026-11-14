import test from "node:test";
import assert from "node:assert/strict";
import { normalizeResearchEvidence, publicCitationUrl } from "../server/research-evidence.js";

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
