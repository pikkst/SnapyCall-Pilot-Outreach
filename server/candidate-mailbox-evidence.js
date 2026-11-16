// Durable provider classification, separate from DNS and person-email proof.
// This helper accepts ONLY normalized server-side adapter evidence and is not
// reachable from an HTTP route or client-provided payload.
import { normalizeVerificationAddress } from "./email-deliverability.js";
import { lockActiveWorkspaceMembership } from "./workspace-access.js";

const CUID = /^c[a-z0-9]{10,40}$/;
const STATUS = new Set(["VALID", "INVALID", "RISKY", "UNKNOWN"]);
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

function verifiedEnvelope(evidence, now) {
  const email = normalizeVerificationAddress(evidence?.emailNormalized);
  if (!email ||
      typeof evidence.provider !== "string" ||
      !/^[A-Z][A-Z0-9_]{2,31}$/.test(evidence.provider) ||
      typeof evidence.adapterVersion !== "string" ||
      !/^v[1-9][0-9]{0,2}$/.test(evidence.adapterVersion) ||
      !STATUS.has(evidence.status) ||
      typeof evidence.reason !== "string" ||
      !/^[A-Z_]{2,48}$/.test(evidence.reason) ||
      typeof evidence.billableAttemptUncertain !== "boolean" ||
      (evidence.billableAttemptUncertain && evidence.status !== "UNKNOWN") ||
      !(evidence.checkedAt instanceof Date) ||
      !Number.isFinite(evidence.checkedAt.getTime()) ||
      evidence.checkedAt > now ||
      evidence.checkedAt.getTime() < now.getTime() - TTL_MS) {
    throw new TypeError("Invalid mailbox provider evidence");
  }
  return { email: email.email, provider: evidence.provider,
    adapterVersion: evidence.adapterVersion, status: evidence.status,
    reason: evidence.reason, billableAttemptUncertain: evidence.billableAttemptUncertain,
    checkedAt: evidence.checkedAt, expiresAt: new Date(evidence.checkedAt.getTime() + TTL_MS) };
}

export async function persistCandidateMailboxEvidence(db, {
  workspaceId, ownerId, candidateId,
}, evidence, { now = () => new Date() } = {}) {
  if (![workspaceId, ownerId, candidateId].every(id =>
    typeof id === "string" && CUID.test(id)) || typeof now !== "function") {
    throw new TypeError("Verified candidate scope required");
  }
  const clock = now();
  if (!(clock instanceof Date) || !Number.isFinite(clock.getTime())) {
    throw new TypeError("Invalid verification clock");
  }
  const checked = verifiedEnvelope(evidence, clock);
  return db.$transaction(async tx => {
    if (!await lockActiveWorkspaceMembership(tx, { workspaceId, userId: ownerId })) {
      return { status: 403, code: "WORKSPACE_ACCESS_REVOKED" };
    }
    const rows = await tx.$queryRaw`
      SELECT "id", "email" FROM "Candidate"
      WHERE "id" = ${candidateId} AND "workspaceId" = ${workspaceId}
      FOR UPDATE`;
    if (rows.length !== 1) return { status: 404, code: "CANDIDATE_NOT_FOUND" };
    const email = normalizeVerificationAddress(rows[0].email);
    if (!email || checked.email !== email.email) {
      return { status: 409, code: "EMAIL_CHANGED_RECHECK_REQUIRED" };
    }
    const existing = await tx.candidateMailboxVerification.findUnique({
      where: { candidateId },
      select: { checkedAt: true, provider: true, adapterVersion: true,
        emailNormalized: true, status: true, reason: true,
        billableAttemptUncertain: true },
    });
    // An older response must never overwrite a newer provider observation.
    if (existing && existing.checkedAt > checked.checkedAt) {
      return { status: 409, code: "OLDER_VERIFICATION_REJECTED" };
    }
    if (existing && existing.checkedAt.getTime() === checked.checkedAt.getTime()) {
      const same = existing.emailNormalized === checked.email &&
        existing.provider === checked.provider &&
        existing.adapterVersion === checked.adapterVersion &&
        existing.status === checked.status &&
        existing.reason === checked.reason &&
        existing.billableAttemptUncertain === checked.billableAttemptUncertain;
      if (!same) return { status: 409, code: "VERIFICATION_CONFLICT" };
      return { status: 200, code: "MAILBOX_VERIFICATION_UNCHANGED",
        provider: checked.provider, verificationStatus: checked.status,
        checkedAt: checked.checkedAt, expiresAt: checked.expiresAt,
        personEmailLinked: false, usableAsContact: false,
        onboardingEligible: false, sendingEnabled: false };
    }
    const value = {
      workspaceId, emailNormalized: checked.email,
      provider: checked.provider, adapterVersion: checked.adapterVersion,
      status: checked.status, reason: checked.reason,
      billableAttemptUncertain: checked.billableAttemptUncertain,
      checkedAt: checked.checkedAt, expiresAt: checked.expiresAt,
    };
    await tx.candidateMailboxVerification.upsert({
      where: { candidateId }, create: { candidateId, ...value },
      update: value,
    });
    await tx.auditEvent.create({ data: {
      actorId: ownerId, action: "candidate.mailbox-verification.saved",
      entityId: candidateId, metadata: {
        workspaceId, provider: checked.provider, adapterVersion: checked.adapterVersion,
        status: checked.status, billableAttemptUncertain: checked.billableAttemptUncertain,
        // Never log email, domain, or raw provider response.
        onboardingEligible: false,
      },
    } });
    return { status: 200, code: "MAILBOX_VERIFICATION_SAVED",
      provider: checked.provider, verificationStatus: checked.status,
      checkedAt: checked.checkedAt, expiresAt: checked.expiresAt,
      personEmailLinked: false, usableAsContact: false,
      onboardingEligible: false, sendingEnabled: false };
  });
}

// The UI may report the provider's technical classification, but never infer
// contact ownership, permission, verified identity, or sending eligibility.
export function visibleCandidateMailboxEvidence(candidate, snapshot, now = new Date()) {
  const email = normalizeVerificationAddress(candidate?.email);
  const saved = normalizeVerificationAddress(snapshot?.emailNormalized);
  if (!snapshot || !email || !saved || email.email !== saved.email ||
      !(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      !(snapshot.checkedAt instanceof Date) || snapshot.checkedAt > now ||
      !(snapshot.expiresAt instanceof Date) || snapshot.expiresAt <= now ||
      !STATUS.has(snapshot.status) || snapshot.billableAttemptUncertain === true) {
    return null;
  }
  return Object.freeze({
    provider: snapshot.provider, status: snapshot.status,
    checkedAt: snapshot.checkedAt, expiresAt: snapshot.expiresAt,
    providerSaysDeliverable: snapshot.status === "VALID",
    personEmailLinked: false, usableAsContact: false,
    onboardingEligible: false, sendingEnabled: false,
  });
}
