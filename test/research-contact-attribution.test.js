import test from "node:test";
import assert from "node:assert/strict";
import {
  associateBusinessContactsWithCandidates,
  findCandidateIdentityCollisions,
} from "../server/research-contact-attribution.js";

const url = "https://company.example.org/team";
const businessContact = {
  type: "PUBLIC_BUSINESS_INBOX", observedEmail: "info@company.example.org",
  sourceUrl: url, provenance: "SERVER_INSPECTED_PAGE",
  status: "REVIEW_REQUIRED", identityVerified: false,
  contactPermission: false,
};
const person = name => ({ name, sourceUrl: url });

test("a unique cited-page association never verifies ownership, identity or consent", () => {
  assert.deepEqual(associateBusinessContactsWithCandidates(
    [person("Alex Example")], [businessContact],
  ), [{
    sourceUrl: url, observedEmail: "info@company.example.org",
    candidateNames: ["Alex Example"],
    relationship: "SAME_CITED_PAGE_UNVERIFIED",
    organizationVerified: false, identityVerified: false,
    contactPermission: false, reviewRequired: true,
  }]);
});

test("one team-page business inbox shared by two experts stays ambiguous", () => {
  const found = associateBusinessContactsWithCandidates(
    [person("Alex Example"), person("Sam Example"), person("Alex Example")],
    [businessContact, businessContact],
  );
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].candidateNames, ["Alex Example", "Sam Example"]);
  assert.equal(found[0].relationship, "SHARED_SOURCE_AMBIGUOUS");
  assert.equal(found[0].identityVerified, false);
});

test("untrusted model contacts, off-source addresses and forged review status are ignored", () => {
  for (const contact of [
    { ...businessContact, provenance: "MODEL_GENERATED" },
    { ...businessContact, sourceUrl: "https://another.example.org" },
    { ...businessContact, status: "VERIFIED" },
    { ...businessContact, identityVerified: true },
    { ...businessContact, contactPermission: true },
  ]) {
    assert.deepEqual(associateBusinessContactsWithCandidates(
      [person("Alex Example")], [contact],
    ), []);
  }
});

test("same spelling across different cited sources flags possible namesakes without merging", () => {
  const found = findCandidateIdentityCollisions([
    person("Alex  Example"),
    { name: "alex example", sourceUrl: "https://other.example.org/profile" },
    { name: "Alex Example", sourceUrl: "https://other.example.org/profile#bio" },
    { name: "Different Name", sourceUrl: "https://third.example.org" },
  ]);
  assert.equal(found.length, 1);
  assert.equal(found[0].name, "Alex Example");
  assert.deepEqual(found[0].sourceUrls, [
    url, "https://other.example.org/profile",
  ]);
  assert.equal(found[0].automaticMergeAllowed, false);
  assert.equal(found[0].status, "IDENTITY_REVIEW_REQUIRED");
});

test("unbounded attribution and malformed inputs fail closed", () => {
  assert.throws(() => associateBusinessContactsWithCandidates(
    Array(21).fill(person("X")), [],
  ), TypeError);
  assert.throws(() => findCandidateIdentityCollisions(Array(21).fill(person("X"))), TypeError);
});


test("evidence completeness ranking is stable and never certifies individual identity", async () => {
  const { orderCandidatesForEvidenceReview } =
    await import("../server/research-contact-attribution.js");
  const base = [
    { name: "Citation only", sourceUrl: "https://third.example.org/profile" },
    { name: "Inspected empty", sourceUrl: "https://second.example.org/profile" },
    { name: "Observed company", sourceUrl: url },
    { name: "Also observed", sourceUrl: url },
  ];
  const ranked = orderCandidatesForEvidenceReview(base,
    ["https://second.example.org/profile", url], [businessContact]);
  assert.deepEqual(ranked.map(x => x.name),
    ["Observed company", "Also observed", "Inspected empty", "Citation only"]);
  assert.deepEqual(ranked.map(x => x.evidenceLevel),
    ["PUBLIC_SOURCE_WITH_UNVERIFIED_BUSINESS_INBOX",
      "PUBLIC_SOURCE_WITH_UNVERIFIED_BUSINESS_INBOX",
      "PUBLIC_SOURCE_INSPECTED_NO_CONTACT", "PROVIDER_CITATION_ONLY"]);
  assert.ok(ranked.every(x => x.manualReviewRequired && !x.individualEmailVerified));
  assert.equal(base[0].name, "Citation only", "Ranking must not mutate candidate order");
});

test("forged model business-inbox claims do not improve evidence ranking", async () => {
  const { orderCandidatesForEvidenceReview } =
    await import("../server/research-contact-attribution.js");
  const forged = { ...businessContact, provenance: "MODEL_GENERATED" };
  const ranked = orderCandidatesForEvidenceReview([person("Example")], [url], [forged]);
  assert.equal(ranked[0].evidenceLevel, "PUBLIC_SOURCE_INSPECTED_NO_CONTACT");
});
