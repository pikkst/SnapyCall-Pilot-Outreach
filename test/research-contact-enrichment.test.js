import test from "node:test";
import assert from "node:assert/strict";
import { inspectResearchPreview } from "../server/research-contact-enrichment.js";

const urls = [
  "https://first.example.org/consultant",
  "https://second.example.org/profile",
  "https://third.example.org/speaker",
];
const preview = {
  candidates: urls.map((sourceUrl, i) => ({ name: "Expert " + i, sourceUrl })),
  sources: urls.map(url => ({ url, title: "Public expert profile" })),
};

test("bounded source inspection preserves separate unverified business-inbox evidence", async () => {
  const calls = [];
  const output = await inspectResearchPreview(preview, {
    maxPages: 2,
    retrieve: async url => {
      calls.push(url);
      return { url, text: "Contact info@" + new URL(url).hostname };
    },
  });
  assert.deepEqual(calls, urls.slice(0, 2));
  assert.equal(output.pagesInspected, 2);
  assert.equal(output.publicBusinessContacts.length, 2);
  assert.equal(output.contactReviewRequired, true);
  assert.deepEqual(output.evidenceReviewOrder.map(x => x.name),
    ["Expert 0", "Expert 1", "Expert 2"]);
  assert.deepEqual(output.evidenceReviewOrder.map(x => x.evidenceLevel), [
    "PUBLIC_SOURCE_WITH_UNVERIFIED_BUSINESS_INBOX",
    "PUBLIC_SOURCE_WITH_UNVERIFIED_BUSINESS_INBOX",
    "PROVIDER_CITATION_ONLY",
  ]);
  assert.deepEqual(output.publicBusinessContacts.map(c => c.identityVerified), [false, false]);
  assert.deepEqual(output.publicBusinessContacts.map(c => c.contactPermission), [false, false]);
  assert.deepEqual(output.warnings, []);
});

test("never inspect an uncited candidate URL or a duplicate source", async () => {
  const requests = [];
  const output = await inspectResearchPreview({
    ...preview,
    candidates: [
      { sourceUrl: "https://uncited.example.org" },
      preview.candidates[0], preview.candidates[0],
    ],
  }, { retrieve: async url => {
    requests.push(url);
    return { url, text: "info@first.example.org" };
  } });
  assert.deepEqual(requests, [urls[0]]);
  assert.equal(output.publicBusinessContacts.length, 1);
});

test("source inspection failure is sanitized; redirect mismatch never becomes contact evidence", async () => {
  const output = await inspectResearchPreview(preview, {
    maxPages: 2, retrieve: async url => {
      if (url === urls[0]) throw new Error("Authorization secret should not leak");
      return { url: "https://other.example.org", text: "info@other.example.org" };
    },
  });
  assert.deepEqual(output.publicBusinessContacts, []);
  assert.ok(output.evidenceReviewOrder.every(x =>
    x.evidenceLevel === "PROVIDER_CITATION_ONLY"));
  assert.equal(output.warnings.length, 1);
  assert.doesNotMatch(JSON.stringify(output), /Authorization secret/);
  await assert.rejects(() => inspectResearchPreview(preview, { maxPages: 4 }), TypeError);
});


test("review preview corroborates full name from inspected cited page without claiming affiliation", async () => {
  const source = "https://coach.example.org/team";
  const result = await inspectResearchPreview({
    candidates: [{ name: "Morgan Field", sourceUrl: source }],
    sources: [{ url: source, title: "Team profile" }],
  }, {
    retrieve: async url => ({
      url, text: "Meet Morgan Field, consultant. Business inquiries: info@coach.example.org",
    }),
  });
  assert.deepEqual(result.profileObservations, [{
    name: "Morgan Field", sourceUrl: source,
    observation: "EXACT_NAME_ON_INSPECTED_SOURCE",
    profileIdentityVerified: false,
    organizationAffiliationVerified: false,
    contactOwnershipVerified: false,
    reviewRequired: true,
  }]);
  assert.equal(result.publicBusinessContacts.length, 1);
  assert.equal(result.contactAssociations[0].identityVerified, false);
  assert.equal(result.contactAssociations[0].organizationVerified, false);
});


test("named professional email observation requires source citation and nearby full name", async () => {
  const source = "https://experts.example.org/team/ada";
  const result = await inspectResearchPreview({
    candidates: [{ name: "Ada Mentor", sourceUrl: source }],
    sources: [{ url: source, title: "Team profile" }],
  }, { retrieve: async url => ({
    url, text: "Ada Mentor — AI workflow consultant. Email ada.mentor@experts.example.org"
  }) });
  assert.deepEqual(result.publicNamedContactObservations, [{
    type: "PUBLIC_NAMED_EMAIL_OBSERVATION",
    observedEmail: "ada.mentor@experts.example.org",
    sourceUrl: source,
    candidateNames: ["Ada Mentor"],
    relationship: "NAME_NEAR_EMAIL_UNVERIFIED",
    provenance: "SERVER_INSPECTED_PAGE", status: "REVIEW_REQUIRED",
    identityVerified: false, contactPermission: false,
    deliverabilityVerified: false,
  }]);
  assert.equal(result.publicBusinessContacts.length, 0);
});

test("named email is not inferred when a profile has no contextual email proof", async () => {
  const source = "https://experts.example.org/team/ada";
  const result = await inspectResearchPreview({
    candidates: [{ name: "Ada Mentor", sourceUrl: source }],
    sources: [{ url: source, title: "Team profile" }],
  }, { retrieve: async url => ({
    url, text: "Public contact morgan@example.org. Long article ".repeat(10) +
      "The professional Ada Mentor works in AI."
  }) });
  assert.deepEqual(result.publicNamedContactObservations, []);
});

test("multiple names near the same mailbox never produce claimed individual ownership", async () => {
  const source = "https://experts.example.org/team";
  const output = await inspectResearchPreview({
    candidates: [
      { name: "Ada Mentor", sourceUrl: source },
      { name: "Morgan Field", sourceUrl: source },
    ],
    sources: [{ url: source }],
  }, { retrieve: async url => ({
    url, text: "Ada Mentor and Morgan Field — contact team.lead@experts.example.org"
  }) });
  assert.equal(output.publicNamedContactObservations.length, 1);
  assert.equal(output.publicNamedContactObservations[0].relationship,
    "MULTIPLE_NAMES_NEAR_EMAIL_AMBIGUOUS");
  assert.equal(output.publicNamedContactObservations[0].identityVerified, false);
  assert.equal(output.publicNamedContactObservations[0].contactPermission, false);
});
