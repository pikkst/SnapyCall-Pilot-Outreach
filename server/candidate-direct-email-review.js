// Explicit attestation for independently inspected person-email evidence.
// The reviewer cannot change the candidate, evidence, or mail recipient.
import { lockActiveWorkspaceMembership } from "./workspace-access.js";
import { publicCitationUrl } from "./research-evidence.js";
import { visibleDirectEmailObservation } from "./candidate-direct-email-evidence.js";
import { normalizeVerificationAddress } from "./email-deliverability.js";

const CUID = /^c[a-z0-9]{10,40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const REVIEW_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function reviewCandidateDirectEmailEvidence(db, {
  candidateId, workspaceId, ownerId, expectedDigest,
}, { now = () => new Date() } = {}) {
  if (![candidateId, workspaceId, ownerId].every(id =>
    typeof id === "string" && CUID.test(id)) ||
    typeof expectedDigest !== "string" || !SHA256.test(expectedDigest) ||
    typeof now !== "function") throw new TypeError("Invalid reviewer scope or evidence digest");

  const clock = now();
  if (!(clock instanceof Date) || !Number.isFinite(clock.getTime())) {
    throw new TypeError("Invalid review clock");
  }

  return db.$transaction(async tx => {
    if (!await lockActiveWorkspaceMembership(tx, {
      workspaceId, userId: ownerId,
    })) return { status: 403, code: "WORKSPACE_ACCESS_REVOKED" };

    // Serialize reviewer attestation with writes to this candidate.
    const rows = await tx.$queryRaw`
      SELECT "id", "name", "email", "expertProfileUrl", "suppressed"
      FROM "Candidate" WHERE "id" = ${candidateId}
        AND "workspaceId" = ${workspaceId} FOR UPDATE`;
    if (rows.length !== 1) return { status: 404, code: "CANDIDATE_NOT_FOUND" };
    const candidate = rows[0];
    if (candidate.suppressed) return { status: 409, code: "SUPPRESSED_CANDIDATE" };

    const evidence = await tx.candidateDirectEmailObservation.findUnique({
      where: { candidateId },
    });
    if (!evidence || evidence.workspaceId !== workspaceId ||
        evidence.evidenceDigest !== expectedDigest ||
        !["REVIEW_REQUIRED", "PERSON_EMAIL_REVIEWED"].includes(evidence.status) ||
        !(evidence.inspectedAt instanceof Date) ||
        evidence.inspectedAt > clock ||
        clock.getTime() - evidence.inspectedAt.getTime() > REVIEW_TTL_MS ||
        evidence.personName !== candidate.name ||
        !publicCitationUrl(evidence.profileUrl)) {
      return { status: 409, code: "EVIDENCE_REINSPECTION_REQUIRED" };
    }
    // Reuse the exact same display guard for canonical candidate identity.
    const visibility = visibleDirectEmailObservation(candidate, evidence, clock);
    if (!visibility) {
      return { status: 409, code: "CANDIDATE_EVIDENCE_MISMATCH" };
    }

    if (evidence.status === "PERSON_EMAIL_REVIEWED") {
      if (!visibility.personEmailLinked) {
        return { status: 409, code: "REVIEW_ATTESTATION_INVALID" };
      }
      return { status: 200, code: "PERSON_EMAIL_REVIEW_UNCHANGED",
        personEmailLinked: true, usableAsContact: false,
        onboardingEligible: false, sendingEnabled: false };
    }

    // A new candidate often has no email. Bind ONLY the independently
    // inspected, human-confirmed address; never accept a browser-supplied
    // email as part of this approval action.
    if (candidate.email == null) {
      const canonical = normalizeVerificationAddress(evidence.emailNormalized);
      if (!canonical) return { status: 409, code: "EVIDENCE_MAILBOX_INVALID" };
      await tx.candidate.update({
        where: { id: candidateId },
        data: { email: canonical.email, emailNormalized: canonical.email },
      });
    }
    const updated = await tx.candidateDirectEmailObservation.updateMany({
      where: { candidateId, workspaceId, evidenceDigest: expectedDigest,
        status: "REVIEW_REQUIRED" },
      data: { status: "PERSON_EMAIL_REVIEWED",
        reviewedAt: clock, reviewedBy: ownerId },
    });
    if (updated.count !== 1) return { status: 409, code: "REVIEW_STATE_CHANGED" };
    await tx.auditEvent.create({ data: {
      actorId: ownerId, action: "candidate.person-email.reviewed",
      entityId: candidateId, metadata: {
        workspaceId, evidenceDigest: expectedDigest,
        reviewKind: "EXPLICIT_PERSON_EMAIL", onboardingEligible: false },
    } });
    return { status: 200, code: "PERSON_EMAIL_REVIEWED",
      personEmailLinked: true, usableAsContact: false,
      onboardingEligible: false, sendingEnabled: false };
  }).catch(error => {
    // Scoped database uniqueness is the final race fence when another
    // candidate already owns this exact workspace email.
    if (error?.code === "P2002") {
      return { status: 409, code: "EMAIL_ALREADY_ASSIGNED_IN_WORKSPACE" };
    }
    throw error;
  });
}

// Authenticated workspace reviewers can inspect the exact publicly observed
// address before attesting; raw provider payloads are never exposed.
export function directEmailReviewSnapshot(candidate, evidence, now = new Date()) {
  const item = visibleDirectEmailObservation(candidate, evidence, now);
  if (!item || !evidence || !(now instanceof Date) ||
      !Number.isFinite(now.getTime()) ||
      evidence.inspectedAt > now ||
      now.getTime() - evidence.inspectedAt.getTime() > REVIEW_TTL_MS) return null;
  return Object.freeze({ ...item,
    observedEmail: evidence.emailNormalized,
    evidenceDigest: evidence.evidenceDigest,
    reviewRequired: !item.personEmailLinked,
  });
}
