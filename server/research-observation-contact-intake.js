// Explicit, review-gated promotion: source-backed NAME + CATEGORY + EMAIL only.
// The provider-agnostic inspection runs before DB writes and never sends mail.
import { lockActiveWorkspaceMembership } from "./workspace-access.js";
import { inspectCampaignObservationEmail, observationInspectionSource }
  from "./research-observation-email.js";
import { normalizeVerificationAddress } from "./email-deliverability.js";
import { canonicalEvidenceUrl } from "../src/evidence.js";

const ID = /^c[a-z0-9]{10,40}$/;
const SHA = /^[a-f0-9]{64}$/;
const GENERIC_MAILBOX = /^(?:info|contact|hello|office|team|support|business|booking|bookings|partners|partnerships)$/i;

export async function acceptReviewedCampaignContact(db, {
  campaignId, observationId, workspaceId, ownerId,
  expectedDigest, confirmsExactPersonEmailPair,
}, { inspect = inspectCampaignObservationEmail, now = () => new Date() } = {}) {
  if (![campaignId, observationId, workspaceId, ownerId].every(v =>
      typeof v === "string" && ID.test(v)) ||
      typeof expectedDigest !== "string" || !SHA.test(expectedDigest) ||
      confirmsExactPersonEmailPair !== true ||
      typeof inspect !== "function" || typeof now !== "function") {
    throw new TypeError("Explicit scoped person-email attestation required");
  }
  const finding = await inspect(db, {
    campaignId, observationId, workspaceId, ownerId,
  });
  if (finding.status !== 200 || finding.code !==
      "NAMED_EMAIL_EVIDENCE_REVIEW_REQUIRED" ||
      finding.evidenceDigest !== expectedDigest ||
      finding.reviewRequired !== true) {
    return { status: 409, code: "FRESH_PERSON_EMAIL_EVIDENCE_REQUIRED",
      contactCreated: false };
  }
  const normalized = normalizeVerificationAddress(finding.observedEmail);
  if (!normalized || normalized.email !== finding.observedEmail ||
      GENERIC_MAILBOX.test(normalized.email.split("@")[0]) ||
      typeof finding.name !== "string" ||
      typeof finding.category !== "string" ||
      typeof finding.sourceUrl !== "string") {
    return { status: 409, code: "INVALID_PERSON_EMAIL_EVIDENCE",
      contactCreated: false };
  }
  const inspectedAt = now();
  if (!(inspectedAt instanceof Date) || !Number.isFinite(inspectedAt.getTime())) {
    throw new TypeError("Invalid review clock");
  }
  const evidenceUrl = canonicalEvidenceUrl(finding.sourceUrl);
  return db.$transaction(async tx => {
    if (!await lockActiveWorkspaceMembership(tx, { workspaceId, userId: ownerId })) {
      return { status: 403, code: "WORKSPACE_ACCESS_REVOKED", contactCreated: false };
    }
    const campaigns = await tx.$queryRaw`
      SELECT "id" FROM "ResearchCampaign"
      WHERE "id" = ${campaignId} AND "workspaceId" = ${workspaceId}
        AND "ownerId" = ${ownerId}
      FOR UPDATE`;
    if (campaigns.length !== 1) {
      return { status: 404, code: "CAMPAIGN_NOT_FOUND", contactCreated: false };
    }
    const matches = await tx.$queryRaw`
      SELECT "id", "name", "category", "citationUrl", "candidateId",
        "groundingStatus", "groundingResolvedUrl", "groundingProvenance",
        "personSourceUrl", "personSourceProvenance", "personSourceVerifiedAt",
        "emailTriageStatus", "emailTriageDigest"
      FROM "ResearchCampaignObservation"
      WHERE "id" = ${observationId} AND "campaignId" = ${campaignId}
      FOR UPDATE`;
    const observation = matches[0];
    if (!observation || matches.length !== 1 ||
        observation.name !== finding.name ||
        observation.category !== finding.category ||
        observationInspectionSource(observation) !== finding.sourceUrl) {
      return { status: 409, code: "OBSERVATION_CHANGED", contactCreated: false };
    }
    // Source collisions are checked while the campaign row is locked.
    // A provider redirect can resolve to a directory shared by other experts.
    const sharedSources = await tx.researchCampaignObservation.count({
      where: { campaignId, id: { not: observationId },
        OR: [{ citationUrl: finding.sourceUrl },
          { groundingResolvedUrl: finding.sourceUrl },
          { personSourceUrl: finding.sourceUrl }] },
    });
    if (sharedSources) {
      return { status: 409, code: "SHARED_SOURCE_REQUIRES_REVIEW",
        contactCreated: false };
    }
    // Serialize all contact-intake operations in this workspace so the
    // email unique index and source binding remain deterministic.
    const partners = await tx.$queryRaw`
      SELECT "id" FROM "Partner" WHERE "id" = ${workspaceId}
      FOR UPDATE`;
    if (partners.length !== 1) {
      return { status: 403, code: "WORKSPACE_UNAVAILABLE", contactCreated: false };
    }
    const existing = await tx.candidate.findFirst({
      where: { workspaceId, OR: [
        { emailNormalized: normalized.email },
        { expertProfileUrl: finding.sourceUrl },
      ] },
      select: { id: true, name: true, category: true,
        emailNormalized: true, expertProfileUrl: true, removedAt: true },
    });
    // Never attach evidence to an existing, possibly different identity by
    // matching only name, source or email. Exact idempotent replay is allowed.
    if (existing) {
      // Research may finish after a user removes the linked contact. Do not
      // re-promote a removed record or count it as a newly saved contact.
      if (existing.removedAt != null) {
        return { status: 409, code: "CONTACT_REMOVED",
          contactCreated: false, sendingEnabled: false };
      }
      if (observation.candidateId === existing.id &&
          existing.name === finding.name &&
          existing.category === finding.category &&
          existing.emailNormalized === normalized.email &&
          existing.expertProfileUrl === finding.sourceUrl) {
        return { status: 200, code: "CONTACT_ALREADY_LINKED",
          candidateId: existing.id, contactCreated: false,
          sendingEnabled: false };
      }
      return { status: 409, code: "CONTACT_IDENTITY_COLLISION",
        contactCreated: false };
    }
    if (observation.candidateId) {
      return { status: 409, code: "OBSERVATION_ALREADY_LINKED",
        contactCreated: false };
    }
    const candidate = await tx.candidate.create({ data: {
      workspaceId, kind: "EXPERT", name: finding.name,
      category: finding.category, email: normalized.email,
      emailNormalized: normalized.email,
      expertProfileUrl: finding.sourceUrl,
      sourceUrl: finding.sourceUrl, researchCitationUrl: observation.citationUrl,
      status: "REVIEW_PENDING",
      profileReviewed: false, contactReviewed: false,
      onlineEnglish: false, suppressed: false,
    } });
    // This action explicitly confirms the exact re-inspected digest; it does
    // NOT imply verified mailbox deliverability, legal basis or send consent.
    await tx.candidateDirectEmailObservation.create({ data: {
      candidateId: candidate.id, workspaceId, personName: finding.name,
      emailNormalized: normalized.email, profileUrl: finding.sourceUrl,
      evidenceDigest: expectedDigest, status: "PERSON_EMAIL_REVIEWED",
      inspectedAt, reviewedAt: inspectedAt, reviewedBy: ownerId,
    } });
    await tx.candidateEvidence.create({ data: {
      candidateId: candidate.id, workspaceId, kind: "PROFILE",
      sourceUrl: finding.sourceUrl, normalizedUrl: evidenceUrl,
      capturedAt: inspectedAt, capturedBy: ownerId,
      note: "Explicit public profile and person-email review",
    } });
    const linked = await tx.researchCampaignObservation.updateMany({
      where: { id: observationId, campaignId, candidateId: null },
      data: { candidateId: candidate.id },
    });
    if (linked.count !== 1) throw new Error("OBSERVATION_LINK_CONFLICT");
    await tx.auditEvent.create({ data: {
      actorId: ownerId, entityId: candidate.id,
      action: "research.campaign.reviewed-contact.created",
      metadata: { workspaceId, campaignId, observationId,
        evidenceDigest: expectedDigest, sendingEnabled: false },
    } });
    return { status: 201, code: "CONTACT_CREATED_REVIEW_PENDING",
      candidateId: candidate.id, contactCreated: true,
      emailReviewed: true, profileReviewed: false,
      onboardingEligible: false, sendingEnabled: false };
  }).catch(error => {
    if (error?.code === "P2002") {
      return { status: 409, code: "CONTACT_IDENTITY_COLLISION",
        contactCreated: false };
    }
    throw error;
  });
}
