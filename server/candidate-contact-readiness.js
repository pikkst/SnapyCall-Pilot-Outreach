// Workspace-scoped contact readiness projection from persisted evidence.
// Do not trust arbitrary client flags, generic mailboxes, or DNS MX as proof.
import { directEmailReviewSnapshot } from "./candidate-direct-email-review.js";
import { visibleCandidateMailboxEvidence } from "./candidate-mailbox-evidence.js";
import { outreachDecision, qualificationDecision } from "../src/domain.js";

export function projectCandidateContactReadiness(candidate, {
  directEmailObservation = null, mailboxVerification = null,
} = {}, now = new Date()) {
  if (!candidate || typeof candidate !== "object" ||
      !(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("Candidate and valid projection clock required");
  }
  const workspace = candidate.workspaceId;
  // Historical admin records (null workspace) and cross-workspace joined
  // evidence never gain contact eligibility from a legacy relation.
  const ownDirect = workspace && directEmailObservation?.workspaceId === workspace
    ? directEmailObservation : null;
  const ownMailbox = workspace && mailboxVerification?.workspaceId === workspace
    ? mailboxVerification : null;
  const direct = ownDirect ? directEmailReviewSnapshot(candidate, ownDirect, now) : null;
  const mailbox = ownMailbox ? visibleCandidateMailboxEvidence(candidate, ownMailbox, now) : null;
  const personEmailLinked = direct?.personEmailLinked === true;
  const mailboxVerificationStatus = mailbox?.status ?? "UNKNOWN";
  const evidence = Object.freeze({ personEmailLinked, mailboxVerificationStatus });
  const qualification = qualificationDecision(candidate, evidence);
  const outreach = outreachDecision(candidate, evidence);
  return Object.freeze({
    evidence, qualification, outreach,
    contactVerification: Object.freeze({
      personEmail: personEmailLinked ? "REVIEWED" :
        direct?.status === "REVIEW_REQUIRED" ? "REVIEW_REQUIRED" : "UNVERIFIED",
      mailbox: mailboxVerificationStatus,
      // A confirmed personal mailbox is a necessary but not sufficient
      // condition. Drafting also requires legal/contact-review gates.
      usableAsContact: personEmailLinked && mailboxVerificationStatus === "VALID" &&
        candidate.suppressed === false,
      draftEligible: outreach.canDraft,
      onboardingEligible: false,
      sendingEnabled: false,
    }),
  });
}
