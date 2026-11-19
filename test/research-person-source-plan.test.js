import test from "node:test";
import assert from "node:assert/strict";
import { planPersonSourceResolution, publicPersonSourcePlan }
  from "../server/research-person-source-plan.js";

const make = (id, name, url, status = "UNCHECKED", extra = {}) => ({
  id: "cmabcdefghij" + id.padStart(10, "0"),
  name, category: "BUSINESS_STRATEGY", citationUrl: url,
  groundingStatus: "UNCHECKED", groundingResolvedUrl: null,
  groundingProvenance: null, emailTriageStatus: status, ...extra,
});
const shared = "https://people.example.org/team";
const unique = "https://people.example.org/experts/casey";

test("plans only unresolved person-specific source tasks, never links namesakes", () => {
  const rows = [
    make("1", "Alex Example", shared),
    make("2", "Alex Example", shared),
    make("3", "Casey Example", unique),
    make("4", "Dee Example", "https://people.example.org/dee", "REVIEW_REQUIRED"),
    make("5", "Eli Example", "https://people.example.org/eli", "CHECKING"),
    make("6", "Fae Example", "https://people.example.org/fae", "NO_EMAIL"),
  ];
  const plan = planPersonSourceResolution(rows);
  assert.equal(plan.reliable, true);
  assert.equal(plan.needsResolution, 3);
  assert.equal(plan.alreadyInspectable, 1);
  assert.equal(plan.alreadyInspected, 1);
  assert.equal(plan.inFlight, 1);
  // Both Alex observations describe the same name and exact citation;
  // keep the source assertion count but spend on it only once.
  assert.equal(plan.jobs.length, 2);
  assert.equal(plan.jobs[0].reason, "SHARED_SOURCE");
  assert.equal(plan.jobs[1].reason, "ALTERNATE_EMAIL_SOURCE");
  assert.equal(plan.jobs[0].query.includes("Alex Example"), true);
  const projection = publicPersonSourcePlan(plan);
  assert.equal(projection.needsResolution, 3);
  assert.equal(JSON.stringify(projection).includes("Alex"), false);
  assert.equal(JSON.stringify(projection).includes("https://"), false);
  assert.equal(projection.paidCallsAuthorized, false);
  assert.equal(projection.emailSendingEnabled, false);
});

test("distinct citations and categories never collapse namesakes", () => {
  const inputs = [
    make("100", "Jordan Smith", "https://people.example.org/jordan-a", "BLOCKED"),
    make("101", "Jordan Smith", "https://people.example.org/jordan-b", "BLOCKED"),
    make("102", "Jordan Smith", "https://people.example.org/jordan-a", "BLOCKED", {
      category: "AI_AUTOMATION",
    }),
    make("103", "Jordan Smith", "https://people.example.org/jordan-a", "BLOCKED"),
  ];
  const plan = planPersonSourceResolution(inputs);
  assert.equal(plan.needsResolution, 4);
  assert.equal(plan.jobs.length, 3);
  assert.deepEqual(plan.jobs.map(job => job.observationId),
    inputs.slice(0, 3).map(row => row.id));
});

test("opaque and untrusted source hints remain unresolved, without guessing URLs", () => {
  const opaque = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abcdefgh";
  const items = [
    make("7", "Grace Example", opaque),
    make("8", "Hal Example", opaque, "BLOCKED", {
      groundingStatus: "SOURCE_HINT", groundingResolvedUrl: unique,
      groundingProvenance: "MODEL_GENERATED_URL",
    }),
  ];
  const plan = planPersonSourceResolution(items);
  assert.equal(plan.needsResolution, 2);
  assert.ok(plan.jobs.every(j => !("sourceUrl" in j)));
});

test("invalid identity and incomplete or oversized snapshots never report reliable workload", () => {
  assert.equal(planPersonSourceResolution([make("9", "", unique)]).invalidIdentity, 1);
  const bad = planPersonSourceResolution([make("10", "Ivy Example", unique)],
    { complete: false });
  assert.equal(bad.reliable, false);
  assert.equal(bad.needsResolution, 0);
  const batch = Array.from({ length: 251 }, (_, i) =>
    make(String(i + 100), "Person Example " + i,
      "https://people.example.org/profile/" + i, "BLOCKED"));
  assert.equal(planPersonSourceResolution(batch).reliable, false);
  assert.throws(() => planPersonSourceResolution([...batch, make("1000", "Test Example", unique)]),
    TypeError);
  assert.throws(() => planPersonSourceResolution([], { maxJobs: 251 }), TypeError);
  assert.equal(planPersonSourceResolution(batch.slice(0, 250), { maxJobs: 2 })
    .jobs.length, 2);
});

test("no external side effects, mutable shared objects or contact creation", () => {
  const plan = planPersonSourceResolution([make("11", "Ivy Example", shared, "BLOCKED")]);
  assert.equal(plan.jobs.length, 1);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.jobs), true);
  assert.equal(Object.isFrozen(plan.jobs[0]), true);
  assert.equal("candidateId" in plan.jobs[0], false);
  assert.equal("email" in plan.jobs[0], false);
});
