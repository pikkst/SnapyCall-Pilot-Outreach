import test from "node:test";
import assert from "node:assert/strict";
import { corroborateCandidateNames } from "../server/research-profile-corroboration.js";

const url = "https://experts.example.org/team";
const one = { name: "Alex Morgan", sourceUrl: url };

test("an exact complete name on a cited inspected page is only a review observation", () => {
  const findings = corroborateCandidateNames([one], [{
    url, text: "Consultant Alex Morgan offers online business strategy services.",
  }]);
  assert.deepEqual(findings, [{
    name: "Alex Morgan", sourceUrl: url,
    observation: "EXACT_NAME_ON_INSPECTED_SOURCE",
    profileIdentityVerified: false,
    organizationAffiliationVerified: false,
    contactOwnershipVerified: false,
    reviewRequired: true,
  }]);
});

test("partial names, near matches, email usernames and model-only names never corroborate", () => {
  const cases = ["Alex", "Alexa Morgan", "Alex Morganson", "alex.morgan@example.org",
    "Alex-Morgan", "Morgan Alex", "Alex Morgan2"];
  for (const text of cases) {
    const [finding] = corroborateCandidateNames([one], [{ url, text }]);
    assert.equal(finding.observation, "NAME_NOT_OBSERVED", text);
  }
  assert.deepEqual(corroborateCandidateNames([one], []), []);
  assert.deepEqual(corroborateCandidateNames([one], [{
    url: "https://other.example.org/team", text: "Alex Morgan",
  }]), []);
});

test("Unicode names, whitespace and quoted/surnamed people remain bounded and review-only", () => {
  const candidate = { name: "Élodie Müller", sourceUrl: url };
  const [finding] = corroborateCandidateNames([candidate], [{
    url, text: "Our team includes ÉLODIE   MÜLLER, senior advisor.",
  }]);
  assert.equal(finding.observation, "EXACT_NAME_ON_INSPECTED_SOURCE");
  assert.equal(finding.profileIdentityVerified, false);
  const [invalid] = corroborateCandidateNames([
    { name: "A", sourceUrl: url },
  ], [{ url, text: "A" }]);
  assert.equal(invalid.observation, "NAME_NOT_OBSERVED");
});

test("source or collection overflow fails closed", () => {
  assert.throws(() => corroborateCandidateNames(Array(21).fill(one), []), TypeError);
  assert.throws(() => corroborateCandidateNames([one],
    Array(4).fill({ url, text: "Alex Morgan" })), TypeError);
  assert.deepEqual(corroborateCandidateNames([one], [{
    url, text: "Alex Morgan".repeat(10000),
  }]), []);
});
