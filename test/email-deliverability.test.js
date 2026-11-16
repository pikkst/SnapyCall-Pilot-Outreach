import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeVerificationAddress, inspectEmailDomain,
  normalizeVerificationProviderResult, onboardingEmailEligibility,
} from "../server/email-deliverability.js";

test("email normalization rejects malformed or ambiguous mailbox syntax", () => {
  assert.deepEqual(normalizeVerificationAddress("ADA.Smith@Example.ORG"), {
    email: "ada.smith@example.org", local: "ada.smith", domain: "example.org",
  });
  for (const value of ["", "a@b", "a..b@example.org", "a@domain..org",
    " a@example.org", "a@example.org\nBcc:x", "a@localhost",
    "x".repeat(65) + "@example.org", "foo<>@example.org"]) {
    assert.equal(normalizeVerificationAddress(value), null, value);
  }
});

test("MX presence never claims that a mailbox exists", async () => {
  const check = await inspectEmailDomain("ada@example.org", {
    resolveMx: async () => [{ exchange: "mail.example.org", priority: 10 }],
  });
  assert.deepEqual(check, {
    status: "UNKNOWN", reason: "MX_PRESENT", domainAcceptsMail: true,
  });
});

test("null MX, absent MX and DNS failures remain distinct", async () => {
  assert.equal((await inspectEmailDomain("ada@example.org", {
    resolveMx: async () => [{ exchange: ".", priority: 0 }],
  })).status, "INVALID");
  assert.equal((await inspectEmailDomain("ada@example.org", {
    resolveMx: async () => [],
  })).reason, "NO_MX_FALLBACK_UNCHECKED");
  assert.equal((await inspectEmailDomain("ada@example.org", {
    resolveMx: async () => { throw new Error("ENOTFOUND"); },
  })).status, "UNKNOWN");
  assert.equal((await inspectEmailDomain("bad@", {
    resolveMx: () => { throw new Error("Must never query DNS"); },
  })).status, "INVALID");
});

test("provider classification is allowlisted, never blindly trusted", () => {
  assert.deepEqual(normalizeVerificationProviderResult({
    status: "VALID", reason: "MAILBOX_ACCEPTED", secret: "private",
  }), { status: "VALID", reason: "MAILBOX_ACCEPTED" });
  assert.equal(normalizeVerificationProviderResult({ status: "deliverable" }).status, "UNKNOWN");
  assert.equal(normalizeVerificationProviderResult({ status: "RISKY" }).status, "RISKY");
});

const candidate = {
  email: "ada@example.org", personEmailLinked: true,
  personEmailEvidenceReviewed: true,
  personEmailSourceUrl: "https://example.org/people/ada",
  suppressed: false, contactReviewed: true, legalBasis: "Reviewed legal basis",
};
const verified = {
  email: "ada@example.org", status: "VALID",
  checkedAt: "2026-11-16T12:00:00.000Z",
};
const clock = { now: new Date("2026-11-16T13:00:00.000Z") };

test("only directly linked fresh VALID professional email can pass eligibility", () => {
  const result = onboardingEmailEligibility(candidate, verified, clock);
  assert.equal(result.eligible, true);
  assert.equal(result.sendEnabled, false);
  assert.deepEqual(result.blockers, []);
});

test("an MX-only UNKNOWN result, wrong email, stale check and missing identity block", () => {
  const samples = [
    [candidate, { ...verified, status: "UNKNOWN" }, "DELIVERABILITY_NOT_CONFIRMED"],
    [candidate, { ...verified, email: "morgan@example.org" }, "EMAIL_VERIFICATION_MISMATCH"],
    [candidate, { ...verified, checkedAt: "2025-01-01T00:00:00Z" }, "DELIVERABILITY_CHECK_STALE"],
    [{ ...candidate, personEmailLinked: false }, verified, "PERSON_EMAIL_LINK_NOT_VERIFIED"],
    [{ ...candidate, personEmailSourceUrl: null }, verified, "PERSON_EMAIL_LINK_NOT_VERIFIED"],
    [{ ...candidate, contactReviewed: false }, verified, "CONTACT_LEGAL_REVIEW_REQUIRED"],
    [{ ...candidate, suppressed: true }, verified, "SUPPRESSION_NOT_CLEARED"],
  ];
  for (const [person, evidence, expected] of samples) {
    const result = onboardingEmailEligibility(person, evidence, clock);
    assert.equal(result.eligible, false);
    assert.ok(result.blockers.includes(expected), expected);
  }
});

test("organization inbox never becomes a named person recipient, even with VALID classification", () => {
  const result = onboardingEmailEligibility({
    ...candidate, email: "info@example.org",
  }, { ...verified, email: "info@example.org" }, clock);
  assert.equal(result.eligible, false);
  assert.ok(result.blockers.includes("ORG_INBOX_NOT_PERSONAL"));
});
