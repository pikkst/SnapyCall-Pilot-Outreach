// Independently inspect one provider-proposed public person profile.
// Never infer email patterns, consent, mailbox validity or contact acceptance.
import { isWorkspaceId, lockActiveWorkspaceMembership,
  requireWorkspaceMembership } from "./workspace-access.js";
import { retrieveCitedPublicPage } from "./research-public-pages.js";
import { inspectNamedPublicContactEvidence, LINKED_CONTACT_PROVENANCE }
  from "./research-linked-contact-proof.js";
import { isDirectPublicProfileUrl }
  from "./research-observation-email.js";
import { personSourceFingerprint }
  from "./research-person-source-queue.js";

const REVIEW = "NAMED_EMAIL_EVIDENCE_REVIEW_REQUIRED";
const PROOF = "AI98_EXPLICIT_NAMED_EMAIL_ON_PUBLIC_PROFILE";
const PUBLIC_PAGE_FAILURE_CODES = new Set([
  "PUBLIC_PAGE_URL_REJECTED", "PUBLIC_PAGE_DNS_REJECTED",
  "PUBLIC_PAGE_NO_VALID_IPV4", "PUBLIC_PAGE_REDIRECT_REJECTED",
  "PUBLIC_PAGE_HTTP_REJECTED", "PUBLIC_PAGE_TOO_LARGE",
  "PUBLIC_PAGE_TIMEOUT", "PUBLIC_PAGE_ROBOTS_REJECTED",
  "PUBLIC_PAGE_CONTENT_REJECTED",
]);

// Only static errors from the trusted public HTTPS reader are observable.
// Do not persist exception messages, URLs, response bodies or private DNS.
export function classifyPersonSourceInspectionFailure(error) {
  return error instanceof Error && PUBLIC_PAGE_FAILURE_CODES.has(error.message)
    ? error.message : "PUBLIC_PAGE_OTHER_UNAVAILABLE";
}


function scopeValid({ campaignId, workspaceId, ownerId, jobId }) {
  return [campaignId, workspaceId, ownerId, jobId].every(isWorkspaceId);
}

// Only the exact active cycle may inspect its own proposed page. Consent
// still originates from the immutable full-run and original stage approval.
export async function personSourceReadAuthorized(db, scope, job, clock) {
  const approval = await db.researchPersonSourceApproval.findUnique({
    where: { campaignId: scope.campaignId },
  });
  if (!approval || approval.workspaceId !== scope.workspaceId ||
      approval.ownerId !== scope.ownerId ||
      approval.publicInspectionAuthorized !== true) return false;
  if (!job.cycleIndex) {
    return ["APPROVED", "RUNNING"].includes(approval.status) &&
      approval.expiresAt instanceof Date && approval.expiresAt > clock;
  }
  if (!["COMPLETED", "PARTIAL_BUDGET"].includes(approval.status)) return false;
  const cycle = await db.researchPersonSourceCycle.findUnique({
    where: { campaignId_cycleIndex: {
      campaignId: scope.campaignId, cycleIndex: job.cycleIndex,
    } },
  });
  const full = await db.researchFullRun.findUnique({
    where: { campaignId: scope.campaignId },
  });
  return !!cycle && !!full && cycle.workspaceId === scope.workspaceId &&
    cycle.ownerId === scope.ownerId && full.workspaceId === scope.workspaceId &&
    full.ownerId === scope.ownerId && full.status === "SOURCE_RUNNING" &&
    full.publicInspectionAuthorized === true &&
    ["APPROVED", "RUNNING"].includes(cycle.status) &&
    cycle.expiresAt instanceof Date && cycle.expiresAt > clock &&
    full.expiresAt instanceof Date && full.expiresAt > clock;
}

// Classifier failure is a terminal read result, not permission to fetch other
// websites or trust the original AI citation. Fail closed on ambiguous pages.
export async function verifyPersonSourceProposal(db, scope, {
  retrieve = retrieveCitedPublicPage, now = () => new Date(),
} = {}) {
  if (!scopeValid(scope) || typeof retrieve !== "function" ||
      typeof now !== "function") {
    throw new TypeError("Scoped, bounded person source inspection required");
  }
  const clock = now();
  if (!(clock instanceof Date) || !Number.isFinite(clock.getTime())) {
    throw new TypeError("Valid public inspection clock required");
  }
  // Avoid even making an external public-page request for a revoked user.
  // The locked check below protects the later evidence write independently.
  if (!await requireWorkspaceMembership(db, {
    workspaceId: scope.workspaceId, userId: scope.ownerId,
  })) return { status: 403, code: "WORKSPACE_ACCESS_REVOKED" };
  const campaign = await db.researchCampaign.findFirst({
    where: { id: scope.campaignId, workspaceId: scope.workspaceId,
      ownerId: scope.ownerId },
    select: { id: true },
  });
  if (!campaign) return { status: 404, code: "CAMPAIGN_NOT_FOUND" };
  const job = await db.researchPersonSourceJob.findFirst({
    where: { id: scope.jobId, campaignId: scope.campaignId },
    select: { id: true, observationId: true, evidenceFingerprint: true,
      proposedSourceUrl: true, status: true, cycleIndex: true },
  });
  if (!job) return { status: 404, code: "SOURCE_JOB_NOT_FOUND" };
  if (!await personSourceReadAuthorized(db, scope, job, clock)) {
    return { status: 409, code: "PUBLIC_INSPECTION_NOT_AUTHORIZED" };
  }
  if (job.status === "VERIFIED") {
    return { status: 200, code: "PERSON_SOURCE_ALREADY_VERIFIED",
      qualifiedEvidence: true, contactCreated: false, sendingEnabled: false };
  }
  if (job.status !== "COMPLETED") {
    return { status: 409, code: "SOURCE_JOB_NOT_READY" };
  }
  const url = isDirectPublicProfileUrl(job.proposedSourceUrl);
  if (!url || url !== job.proposedSourceUrl) {
    return { status: 409, code: "DIRECT_PERSON_SOURCE_REQUIRED" };
  }
  const observation = await db.researchCampaignObservation.findFirst({
    where: { id: job.observationId, campaignId: scope.campaignId },
    select: { id: true, name: true, category: true, citationUrl: true,
      groundingStatus: true, groundingResolvedUrl: true,
      groundingProvenance: true, emailTriageStatus: true,
      emailTriageLeaseToken: true, candidateId: true,
      personSourceUrl: true },
  });
  if (!observation ||
      personSourceFingerprint(observation) !== job.evidenceFingerprint ||
      observation.candidateId != null || observation.personSourceUrl != null ||
      observation.emailTriageLeaseToken != null ||
      !["UNCHECKED", "BLOCKED", "NO_EMAIL"].includes(observation.emailTriageStatus)) {
    return { status: 409, code: "SOURCE_OBSERVATION_CHANGED" };
  }
  // Shared directory and shared proposed-URL attribution are unsafe even
  // when the external page contains a labeled email address.
  const shared = await db.researchPersonSourceJob.count({
    where: { campaignId: scope.campaignId, id: { not: job.id },
      proposedSourceUrl: url },
  });
  const observedShared = await db.researchCampaignObservation.count({
    where: { campaignId: scope.campaignId, id: { not: observation.id },
      OR: [{ citationUrl: url }, { groundingResolvedUrl: url },
        { personSourceUrl: url }] },
  });
  if (shared || observedShared) {
    return { status: 409, code: "SHARED_SOURCE_REQUIRES_REVIEW" };
  }
  let inspected;
  try {
    inspected = await inspectNamedPublicContactEvidence({
      url, name: observation.name, retrieve,
    });
  } catch (error) {
    return await persistPersonSourceInspection(db, scope, job, observation, {
      clock, url, evidence: null, errorCode: "PUBLIC_PAGE_INSPECTION_UNAVAILABLE",
      inspectionFailureReason: classifyPersonSourceInspectionFailure(error),
    });
  }
  return persistPersonSourceInspection(db, scope, job, observation, {
    clock, url, evidence: inspected.evidence,
    linkedContact: inspected.linked,
    errorCode: inspected.evidence ? null :
      inspected.linkedUnavailable ? "LINKED_CONTACT_UNAVAILABLE" :
      "NO_EXPLICIT_NAMED_EMAIL_ON_PROFILE_OR_CONTACT",
  });
}

async function persistPersonSourceInspection(db, scope, job, observation, {
  clock, url, evidence, errorCode, linkedContact = false,
  inspectionFailureReason = null,
}) {
  return db.$transaction(async tx => {
    if (!await lockActiveWorkspaceMembership(tx, {
      workspaceId: scope.workspaceId, userId: scope.ownerId,
    })) return { status: 403, code: "WORKSPACE_ACCESS_REVOKED" };
    const campaign = await tx.$queryRaw`
      SELECT "id" FROM "ResearchCampaign"
      WHERE "id" = ${scope.campaignId}
        AND "workspaceId" = ${scope.workspaceId}
        AND "ownerId" = ${scope.ownerId}
        AND "status" IN ('PARTIAL', 'COMPLETED') FOR UPDATE`;
    if (campaign.length !== 1) {
      return { status: 409, code: "CAMPAIGN_STATE_CHANGED" };
    }
    const currentJob = await tx.researchPersonSourceJob.findFirst({
      where: { id: job.id, campaignId: scope.campaignId },
    });
    if (!currentJob || currentJob.status !== "COMPLETED" ||
        currentJob.proposedSourceUrl !== url ||
        currentJob.evidenceFingerprint !== job.evidenceFingerprint ||
        currentJob.cycleIndex !== (job.cycleIndex ?? 0)) {
      return { status: 409, code: "SOURCE_JOB_CHANGED" };
    }
    if (!await personSourceReadAuthorized(tx, scope, currentJob, clock)) {
      return { status: 409, code: "PUBLIC_INSPECTION_NOT_AUTHORIZED" };
    }
    const current = await tx.researchCampaignObservation.findFirst({
      where: { id: observation.id, campaignId: scope.campaignId },
    });
    if (!current || current.candidateId != null ||
        current.personSourceUrl != null ||
        current.emailTriageLeaseToken != null ||
        personSourceFingerprint(current) !== job.evidenceFingerprint ||
        !["UNCHECKED", "BLOCKED", "NO_EMAIL"].includes(current.emailTriageStatus)) {
      return { status: 409, code: "SOURCE_OBSERVATION_CHANGED" };
    }
    const shared = await tx.researchPersonSourceJob.count({
      where: { campaignId: scope.campaignId, id: { not: job.id },
        proposedSourceUrl: url },
    });
    const observedShared = await tx.researchCampaignObservation.count({
      where: { campaignId: scope.campaignId, id: { not: observation.id },
        OR: [{ citationUrl: url }, { groundingResolvedUrl: url },
          { personSourceUrl: url }] },
    });
    if (shared || observedShared) {
      return { status: 409, code: "SHARED_SOURCE_REQUIRES_REVIEW" };
    }
    if (evidence && (
      evidence.profileUrl !== url ||
      typeof evidence.emailNormalized !== "string" ||
      typeof evidence.evidenceDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(evidence.evidenceDigest))) {
      return { status: 409, code: "INVALID_PERSON_EMAIL_EVIDENCE" };
    }
    // A single transaction commits named-email evidence and its independently
    // fetched source; this never inserts or approves a Candidate.
    if (evidence) {
      const changed = await tx.researchCampaignObservation.updateMany({
        where: { id: current.id, campaignId: scope.campaignId,
          emailTriageStatus: current.emailTriageStatus,
          personSourceUrl: null, candidateId: null, emailTriageLeaseToken: null },
        data: {
          personSourceUrl: url,
          personSourceProvenance: linkedContact ? LINKED_CONTACT_PROVENANCE : PROOF,
          personSourceVerifiedAt: clock,
          emailTriageStatus: "REVIEW_REQUIRED", emailTriageCode: REVIEW,
          emailTriageEmail: evidence.emailNormalized,
          emailTriageDigest: evidence.evidenceDigest, emailTriageAt: clock,
        },
      });
      if (changed.count !== 1) throw new Error("SOURCE_PROOF_CAS_CONFLICT");
    }
    // A page lacking attributable evidence does NOT prove this person has no
    // public email elsewhere. Preserve a precise, source-scoped terminal state.
    const next = evidence ? "VERIFIED" :
      errorCode === "PUBLIC_PAGE_INSPECTION_UNAVAILABLE"
        ? "SOURCE_UNAVAILABLE" : "SOURCE_NOT_ATTRIBUTABLE";
    const updated = await tx.researchPersonSourceJob.updateMany({
      where: { id: job.id, campaignId: scope.campaignId,
        status: "COMPLETED", proposedSourceUrl: url,
        evidenceFingerprint: job.evidenceFingerprint },
      data: { status: next,
        lastErrorCode: evidence ? REVIEW : errorCode },
    });
    if (updated.count !== 1) throw new Error("SOURCE_INSPECTION_CAS_CONFLICT");
    await tx.auditEvent.create({ data: {
      actorId: scope.ownerId, entityId: job.id,
      action: "research.person-source.inspected",
      metadata: { workspaceId: scope.workspaceId,
        campaignId: scope.campaignId, code: evidence ? REVIEW : errorCode,
        // The original terminal job status is unchanged; this audit-only
        // category diagnoses independent public-page access restrictions.
        ...(inspectionFailureReason ? { inspectionFailureReason } : {}),
        independentlyFetched: true, linkedContactEvidence: !!evidence && linkedContact,
        personEmailEvidence: !!evidence,
        humanReviewed: false, contactCreated: false,
        mailboxVerified: false, sendingEnabled: false },
    } });
    return { status: 200, code: evidence ? REVIEW : errorCode,
      qualifiedEvidence: !!evidence, contactCreated: false,
      sendingEnabled: false };
  });
}
