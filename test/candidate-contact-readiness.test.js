import test from "node:test";
import assert from "node:assert/strict";
import { projectCandidateContactReadiness } from "../server/candidate-contact-readiness.js";

const now = new Date("2026-11-16T17:00:00Z");
const workspaceId = "cmabcdefghijklmnopqrstv";
const email = "ada.mentor@experts.example.org";
const profile = "https://experts.example.org/ada";
const candidate = {
  id: "cmabcdefghijklmnopqrstu", workspaceId,
  name: "Ada Mentor", email, emailNormalized: email,
  expertProfileUrl: profile, category: "AI_AUTOMATION",
  sourceUrl: profile, onlineEnglish: true, profileReviewed: true,
  discoveryKey: "a".repeat(64), suppressed: false,
  contactReviewed: true, legalBasis: "reviewed_business_contact",
};
const directEmailObservation = {
  workspaceId, personName: candidate.name,
  emailNormalized: email, profileUrl: profile,
  evidenceDigest: "a".repeat(64), status: "PERSON_EMAIL_REVIEWED",
  inspectedAt: new Date(now.getTime() - 60000),
  reviewedAt: new Date(now.getTime() - 30000),
  reviewedBy: "cmabcdefghijklmnopqrstw",
};
const mailboxVerification = {
  workspaceId, emailNormalized: email,
  provider: "ZEROBOUNCE", adapterVersion: "v1",
  status: "VALID", reason: "PROVIDER_MAILBOX_REACHABLE",
  billableAttemptUncertain: false,
  checkedAt: new Date(now.getTime() - 60000),
  expiresAt: new Date(now.getTime() + 60000),
};

const project = (person = candidate, direct = directEmailObservation,
  mailbox = mailboxVerification, clock = now) =>
  projectCandidateContactReadiness(person, {
    directEmailObservation: direct, mailboxVerification: mailbox,
  }, clock);

test("person/email review AND current mailbox verdict AND legal review unlock drafting, never sending", () => {
  const x = project();
  assert.equal(x.evidence.personEmailLinked, true);
  assert.equal(x.evidence.mailboxVerificationStatus, "VALID");
  assert.equal(x.contactVerification.personEmail, "REVIEWED");
  assert.equal(x.contactVerification.mailbox, "VALID");
  assert.equal(x.contactVerification.usableAsContact, true);
  assert.equal(x.contactVerification.draftEligible, true);
  assert.equal(x.outreach.canDraft, true);
  assert.equal(x.outreach.canSend, false);
  assert.equal(x.contactVerification.onboardingEligible, false);
  assert.equal(x.contactVerification.sendingEnabled, false);
});

test("an unreviewed named email never counts as usable contact even if vendor says VALID", () => {
  const x = project(candidate, { ...directEmailObservation,
    status: "REVIEW_REQUIRED", reviewedAt: null, reviewedBy: null });
  assert.equal(x.contactVerification.personEmail, "REVIEW_REQUIRED");
  assert.equal(x.contactVerification.usableAsContact, false);
  assert.equal(x.outreach.canDraft, false);
  assert.ok(x.outreach.blockers.includes("person_email_link_unverified"));
});

test("stale mailbox, missing data, unknown status and uncertain billing block draft", () => {
  for (const m of [
    null,
    { ...mailboxVerification, expiresAt: new Date(now.getTime() - 1) },
    { ...mailboxVerification, status: "UNKNOWN" },
    { ...mailboxVerification, status: "RISKY" },
    { ...mailboxVerification, billableAttemptUncertain: true },
    { ...mailboxVerification, emailNormalized: "morgan@example.org" },
  ]) {
    const x = project(candidate, directEmailObservation, m);
    assert.equal(x.contactVerification.usableAsContact, false);
    assert.equal(x.outreach.canDraft, false);
    assert.equal(x.evidence.mailboxVerificationStatus === "VALID", false);
  }
});

test("wrong workspace, changed person, mailbox and profile all fail closed", () => {
  for (const x of [
    project(candidate, { ...directEmailObservation, workspaceId: "cmotherworkspaceotherworksp" }),
    project(candidate, directEmailObservation, {
      ...mailboxVerification, workspaceId: "cmotherworkspaceotherworksp",
    }),
    project({ ...candidate, name: "Morgan Field" }),
    project({ ...candidate, email: "morgan@example.org" }),
    project({ ...candidate, expertProfileUrl: "https://experts.example.org/morgan" }),
    project({ ...candidate, workspaceId: null }),
  ]) {
    assert.equal(x.contactVerification.usableAsContact, false);
    assert.equal(x.outreach.canDraft, false);
  }
});

test("suppression and legal/contact-review requirements remain independent gates", () => {
  for (const candidatePatch of [
    { suppressed: true },
    { legalBasis: null },
    { contactReviewed: false },
    { onlineEnglish: false },
    { profileReviewed: false },
  ]) {
    const x = project({ ...candidate, ...candidatePatch });
    assert.equal(x.outreach.canDraft, false);
    assert.equal(x.outreach.canSend, false);
    assert.equal(x.contactVerification.onboardingEligible, false);
  }
});

test("candidate fields claiming verified identity cannot spoof server-only joined proof", () => {
  const x = project({ ...candidate,
    personEmailLinked: true, mailboxVerificationStatus: "VALID",
  }, null, null);
  assert.equal(x.outreach.canDraft, false);
  assert.equal(x.contactVerification.usableAsContact, false);
});
