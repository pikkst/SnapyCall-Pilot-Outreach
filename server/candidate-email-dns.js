// DNS preflight persistence is candidate-scoped, not a send authorization.
// Always re-read the current email AFTER holding the workspace membership lock.
import { inspectEmailDomain, normalizeVerificationAddress } from "./email-deliverability.js";
import { lockActiveWorkspaceMembership } from "./workspace-access.js";

const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function inspectAndPersistCandidateDns(db, {
  candidateId, workspaceId, ownerId,
}, { inspect = inspectEmailDomain, now = () => new Date() } = {}) {
  if (![candidateId, workspaceId, ownerId].every(value =>
    typeof value === "string" && /^c[a-z0-9]{10,40}$/.test(value)) ||
    typeof inspect !== "function" || typeof now !== "function") {
    throw new TypeError("Verified candidate and workspace scope required");
  }

  const initial = await db.candidate.findFirst({
    where: { id: candidateId, workspaceId },
    select: { id: true, email: true },
  });
  if (!initial) return { status: 404, code: "CANDIDATE_NOT_FOUND" };

  const address = normalizeVerificationAddress(initial.email);
  // Even an invalid email must not cause an external DNS request.
  const dns = await inspect(initial.email);
  if (!dns || !["INVALID", "UNKNOWN"].includes(dns.status) ||
      !/^[A-Z_]{2,48}$/.test(dns.reason) ||
      ![true, false, null].includes(dns.domainAcceptsMail)) {
    throw new TypeError("DNS result cannot assert mailbox validity");
  }

  const checkedAt = now();
  if (!(checkedAt instanceof Date) || !Number.isFinite(checkedAt.getTime())) {
    throw new TypeError("Invalid verification clock");
  }

  return db.$transaction(async tx => {
    if (!await lockActiveWorkspaceMembership(tx, { workspaceId, userId: ownerId })) {
      return { status: 403, code: "WORKSPACE_ACCESS_REVOKED" };
    }
    // Lock the candidate, serializing email updates and the verification write.
    // Never store a result obtained for an earlier address onto a new address.
    const rows = await tx.$queryRaw`
      SELECT "id", "email" FROM "Candidate"
      WHERE "id" = ${candidateId} AND "workspaceId" = ${workspaceId}
      FOR UPDATE`;
    if (rows.length !== 1) return { status: 404, code: "CANDIDATE_NOT_FOUND" };
    const current = normalizeVerificationAddress(rows[0].email);
    if (current?.email !== address?.email) {
      return { status: 409, code: "EMAIL_CHANGED_RECHECK_REQUIRED" };
    }
    const value = {
      workspaceId, emailNormalized: current?.email ?? "",
      checkType: "DNS_MX", status: dns.status, reason: dns.reason,
      domainAcceptsMail: dns.domainAcceptsMail,
      checkedAt, expiresAt: new Date(checkedAt.getTime() + TTL_MS),
    };
    await tx.candidateEmailVerification.upsert({
      where: { candidateId },
      create: { ...value, candidateId },
      update: value,
    });
    await tx.auditEvent.create({ data: {
      actorId: ownerId,
      action: "candidate.email-dns.inspected",
      entityId: candidateId,
      // Do not log email address or domain in audit metadata.
      metadata: { workspaceId, status: dns.status, reason: dns.reason,
        mailboxVerified: false, onboardingEligible: false },
    } });
    return {
      status: 200, code: "DNS_CHECK_SAVED",
      verification: { status: dns.status, reason: dns.reason,
        domainAcceptsMail: dns.domainAcceptsMail, checkedAt,
        expiresAt: value.expiresAt, mailboxVerified: false },
      personEmailLinked: false, usableAsContact: false,
      onboardingEligible: false, sendingEnabled: false,
    };
  });
}

// Fail closed if a candidate changes address or a previously saved check
// expires. Historical DNS observations never authorize mail delivery.
export function visibleCandidateDnsSnapshot(candidate, snapshot, now = new Date()) {
  const address = normalizeVerificationAddress(candidate?.email);
  const stored = normalizeVerificationAddress(snapshot?.emailNormalized);
  const fresh = now instanceof Date && Number.isFinite(now.getTime()) &&
    snapshot?.expiresAt instanceof Date && snapshot.expiresAt > now &&
    snapshot?.checkedAt instanceof Date && snapshot.checkedAt <= now;
  if (!snapshot || !fresh || !address || !stored ||
      address.email !== stored.email || snapshot.checkType !== "DNS_MX" ||
      !["INVALID", "UNKNOWN"].includes(snapshot.status)) return null;
  return Object.freeze({
    status: snapshot.status, reason: snapshot.reason,
    domainAcceptsMail: snapshot.domainAcceptsMail,
    checkedAt: snapshot.checkedAt, expiresAt: snapshot.expiresAt,
    mailboxVerified: false, usableAsContact: false,
    onboardingEligible: false,
  });
}
