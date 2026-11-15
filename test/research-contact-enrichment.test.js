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
