import test from "node:test";
import assert from "node:assert/strict";
import { emailTriageSourceReadiness }
  from "../server/research-email-triage-worker.js";

const person = url => ({
  citationUrl: url, groundingStatus: "UNCHECKED",
  groundingResolvedUrl: null, groundingProvenance: null,
});
const first = person("https://example.org/experts/ada");
const second = person("https://example.org/experts/ben");
const opaque = person(
  "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc");

test("read-only triage preflight requires a terminal discovery and direct unique sources", () => {
  const pending = emailTriageSourceReadiness("RUNNING", [first, second]);
  assert.equal(pending.code, "DISCOVERY_NOT_TERMINAL");
  assert.equal(pending.eligible, false);
  const ready = emailTriageSourceReadiness("PARTIAL", [first, second]);
  assert.deepEqual(ready, {
    eligible: true, partialEligible: false, code: "READY_FOR_OWNER_APPROVAL",
    observations: 2, inspectableObservations: 2,
    uniqueSources: 2, eligibleSubsetObservations: 2, excludedObservations: 0,
    namedPersonEmailVerified: false,
    sendingEnabled: false,
  });
  assert.equal(emailTriageSourceReadiness("COMPLETED", []).code,
    "NO_OBSERVATIONS");
});

test("shared directory citations never become independent person-email evidence", () => {
  const sources = [first, first, second];
  const result = emailTriageSourceReadiness("PARTIAL", sources);
  assert.equal(result.eligible, false);
  assert.equal(result.code, "EMAIL_TRIAGE_SHARED_SOURCE_REVIEW_REQUIRED");
  assert.equal(result.observations, 3);
  assert.equal(result.uniqueSources, 2);
  assert.equal(JSON.stringify(result).includes("https://"), false);
});

test("opaque search redirects or mixed provenance stop immutable batch before approval", () => {
  const result = emailTriageSourceReadiness("PARTIAL", [first, opaque]);
  assert.equal(result.code, "EMAIL_TRIAGE_DIRECT_SOURCE_REQUIRED");
  assert.equal(result.inspectableObservations, 1);
  assert.equal(result.uniqueSources, 1);
  assert.equal(result.eligible, false);
});

test("250-page bound and invalid snapshots fail closed", () => {
  const over = Array.from({ length: 251 }, (_, i) =>
    person("https://example.org/expert-" + i));
  assert.equal(emailTriageSourceReadiness("PARTIAL", over).code,
    "EMAIL_TRIAGE_PAGE_CAP_EXCEEDED");
  assert.equal(emailTriageSourceReadiness("PARTIAL", [first]).eligible, true);
  assert.throws(() => emailTriageSourceReadiness("PARTIAL", Array(252).fill(first)),
    TypeError);
  assert.throws(() => emailTriageSourceReadiness("PARTIAL", null), TypeError);
});

test("partial readiness selects only non-colliding independently inspectable sources", () => {
  const mixed = emailTriageSourceReadiness("PARTIAL",
    [first, first, second, opaque]);
  assert.equal(mixed.eligible, false);
  assert.equal(mixed.partialEligible, true);
  assert.equal(mixed.eligibleSubsetObservations, 1);
  assert.equal(mixed.excludedObservations, 3);
  assert.equal(mixed.code, "EMAIL_TRIAGE_DIRECT_SOURCE_REQUIRED");
  assert.equal(emailTriageSourceReadiness("RUNNING",
    [first, opaque]).partialEligible, false);
  assert.equal(emailTriageSourceReadiness("PARTIAL",
    [first, first]).partialEligible, false);
});
