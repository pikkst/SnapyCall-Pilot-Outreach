import test from "node:test";
import assert from "node:assert/strict";
import { summarizeQualifiedEmailEvidence } from "../server/research-qualified-evidence.js";

const digest = "a".repeat(64);
const person = (name, email, url) => ({
  name, category: "Business consultant", citationUrl: url,
  groundingStatus: "UNCHECKED", groundingResolvedUrl: null,
  groundingProvenance: null, emailTriageStatus: "REVIEW_REQUIRED",
  emailTriageCode: "NAMED_EMAIL_EVIDENCE_REVIEW_REQUIRED",
  emailTriageEmail: email, emailTriageDigest: digest,
  emailTriageAt: new Date("2026-11-18T10:00:00Z"),
});
const ada = person("Ada Lovelace", "ada@example.org", "https://example.org/ada");
const ben = person("Ben Example", "ben@example.org", "https://example.org/ben");

test("counts independent named email evidence but not accepted or sendable contacts", () => {
  assert.deepEqual(summarizeQualifiedEmailEvidence([ada, ben]), {
    qualifiedEvidence: 2, reviewRequired: 2, ambiguous: 0,
    countReliable: true, sendEligible: 0,
    sendingEnabled: false,
  });
});

test("shared directories, duplicate email and opaque citations fail closed", () => {
  const shared = { ...ben, citationUrl: ada.citationUrl };
  const duplicate = { ...ben, emailTriageEmail: ada.emailTriageEmail };
  assert.equal(summarizeQualifiedEmailEvidence([ada, shared]).qualifiedEvidence, 0);
  assert.equal(summarizeQualifiedEmailEvidence([ada, duplicate]).qualifiedEvidence, 0);
  assert.equal(summarizeQualifiedEmailEvidence([{
    ...ada, citationUrl:
      "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc",
  }]).qualifiedEvidence, 0);
});

test("missing digest, generic mailbox, missing category and incorrect status never qualify", () => {
  for (const changed of [
    { emailTriageDigest: null },
    { emailTriageEmail: "info@example.org" },
    { category: "" },
    { emailTriageStatus: "UNCHECKED" },
    { emailTriageCode: "NO_PUBLIC_EMAIL" },
    { emailTriageAt: null },
  ]) {
    assert.equal(summarizeQualifiedEmailEvidence([{ ...ada, ...changed }])
      .qualifiedEvidence, 0);
  }
});

test("maximum-sized snapshots and incomplete reads do not invent success", () => {
  const batch = Array.from({ length: 250 }, (_, i) =>
    person("Expert Person " + i, "expert" + i + "@example.org",
      "https://example.org/person/" + i));
  assert.equal(summarizeQualifiedEmailEvidence(batch).qualifiedEvidence, 250);
  assert.equal(summarizeQualifiedEmailEvidence([...batch, ada]).countReliable, false);
  assert.equal(summarizeQualifiedEmailEvidence(batch, { complete: false })
    .qualifiedEvidence, 0);
  assert.throws(() => summarizeQualifiedEmailEvidence([...batch, ada, ben]), TypeError);
});
