import test from "node:test";
import assert from "node:assert/strict";
import {
  reviewedCandidateKey, resolvedReviewedSource, reviewedSeedBatch,
} from "../src/research-review-batch.js";
import { normalizeManualLeadSeed } from "../server/manual-lead-seed.js";

const candidates = [
  { name: "Ada Mentor", category: "COACHING", sourceUrl: "https://profiles.example.org/ada" },
  { name: "Ben Consultant", category: "AI_AUTOMATION", sourceUrl:
    "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque" },
  { name: "Unreviewed Expert", category: "BUSINESS_STRATEGY",
    sourceUrl: "https://profiles.example.org/unreviewed" },
];
const ada = reviewedCandidateKey(candidates[0]);
const ben = reviewedCandidateKey(candidates[1]);

test("only explicitly inspected, valid public HTTPS profiles enter a review batch", () => {
  const list = reviewedSeedBatch(candidates, [ada, ben], {
    [ben]: "https://consultants.example.com/ben#profile",
  }, []);
  assert.deepEqual(list, [
    { key: ada, manualSeed: true, name: "Ada Mentor",
      category: "COACHING", sourceUrl: "https://profiles.example.org/ada" },
    { key: ben, manualSeed: true, name: "Ben Consultant",
      category: "AI_AUTOMATION", sourceUrl: "https://consultants.example.com/ben" },
  ]);
  for (const { key, ...body } of list) {
    const accepted = normalizeManualLeadSeed(body);
    assert.equal(accepted.sourceUrl, body.sourceUrl);
    assert.equal(Object.hasOwn(body, "email"), false);
    assert.equal(Object.hasOwn(body, "contactReviewed"), false);
  }
});

test("opaque Gemini grounding citations cannot be persisted as contact provenance", () => {
  assert.equal(resolvedReviewedSource(candidates[1], {}), null);
  assert.equal(reviewedSeedBatch(candidates, [ben], {}, []).length, 0);
});

test("previously saved reviewed suggestions are ignored on retry; no duplicate submissions", () => {
  const list = reviewedSeedBatch([...candidates, candidates[0]], [ada, ben], {
    [ben]: "https://consultants.example.com/ben",
  }, [ada]);
  assert.deepEqual(list.map(item => item.name), ["Ben Consultant"]);
});

test("unreviewed suggestions and invalid user-provided sources never enter batch", () => {
  const disallowed = [
    "http://example.org/profile", "https://localhost/profile",
    "https://127.0.0.1/profile", "https://[::1]/",
    "https://user:pass@example.org/", "https://example.org:443/profile",
    "https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque",
    "javascript:alert(1)", "https://org.invalid/path", "https://example.org/" + "a".repeat(2049),
  ];
  for (const url of disallowed) {
    assert.equal(reviewedSeedBatch(candidates, [ben], { [ben]: url }, []).length, 0, url);
  }
  assert.deepEqual(reviewedSeedBatch(candidates, [], {}, []), []);
  assert.deepEqual(reviewedSeedBatch(Array(21).fill(candidates[0]), [ada], {}, []), []);
});

test("user source edits need a fresh explicit review confirmation", () => {
  assert.equal(reviewedSeedBatch(candidates, [ben], {
    [ben]: "https://example.com/reviewed-profile",
  }, []).length, 1);
  assert.equal(reviewedSeedBatch(candidates, [], {
    [ben]: "https://example.com/unreviewed-edited-profile",
  }, []).length, 0);
});
