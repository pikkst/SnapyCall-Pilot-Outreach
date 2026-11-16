// A directly attributed PUBLIC profile observation, not mailbox ownership.
// Never guess addresses, infer consent, or upgrade Candidate contact state.
import { createHash } from "node:crypto";
import { retrieveCitedPublicPage } from "./research-public-pages.js";
import { publicCitationUrl } from "./research-evidence.js";
import { lockActiveWorkspaceMembership } from "./workspace-access.js";

const ID = /^c[a-z0-9]{10,40}$/;
const EMAIL = /[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9.-]{1,190}\.[a-z]{2,24}/gi;
const PERSONAL_MAILBOX = /^(?!info$|contact$|hello$|office$|team$|support$|business$|booking$|bookings$|partners$|partnerships$)[a-z0-9][a-z0-9._%+-]*$/i;

function normalizedEmail(value) {
  if (typeof value !== "string" || value.length > 254 || /[\r\n<>\s]/.test(value)) return null;
  const email = value.toLowerCase();
  if (!/^[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9.-]+\.[a-z]{2,24}$/.test(email) ||
      email.includes("..") || !PERSONAL_MAILBOX.test(email.split("@")[0])) return null;
  return email;
}

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Restrictive evidence pattern: a labeled name then labeled email in the
// SAME individual public profile document. Proximity or generic team pages
// are not sufficient. This is only a triage observation for human review.
export function classifyExplicitPersonEmailPage(candidate, page) {
  const url = publicCitationUrl(candidate?.expertProfileUrl);
  const visited = publicCitationUrl(page?.url);
  const email = normalizedEmail(candidate?.email);
  const name = typeof candidate?.name === "string" ?
    candidate.name.normalize("NFKC").replace(/\s+/g, " ").trim() : "";
  if (!url || url !== visited || !email || name.length < 5 ||
      name.length > 160 || typeof page?.text !== "string" ||
      page.text.length > 200_000) {
    return { status: "UNVERIFIED", reason: "PROFILE_OR_ADDRESS_UNAVAILABLE" };
  }
  const text = page.text.normalize("NFKC").replace(/\s+/g, " ").trim();
  // Count ALL published mailboxes, including generic organization inboxes.
  // A second address makes the page ambiguous even when it is not a usable
  // personal mailbox itself.
  const emails = [...new Set([...text.matchAll(EMAIL)].map(m => m[0].toLowerCase()))];
  if (emails.length !== 1 || emails[0] !== email) {
    return { status: "UNVERIFIED", reason: "ADDRESS_AMBIGUOUS_OR_NOT_PUBLISHED" };
  }
  const nameLabel = new RegExp("(?:^|\\s)(?:Name|Full name|Expert):\\s*" +
    escaped(name) + "(?=\\s|$)", "i");
  const nameMatch = nameLabel.exec(text);
  if (!nameMatch) return { status: "UNVERIFIED", reason: "NO_EXPLICIT_NAMED_PROFILE" };
  const after = text.slice(nameMatch.index + nameMatch[0].length);
  const emailLabel = new RegExp("^(?:.{0,120}?)\\b(?:Email|E-mail):\\s*" +
    escaped(email) + "(?=\\s|$)", "i");
  const match = emailLabel.exec(after);
  if (!match) return { status: "UNVERIFIED", reason: "EMAIL_NOT_EXPLICITLY_ASSOCIATED" };
  const digest = createHash("sha256").update(JSON.stringify([
    url, name.toLocaleLowerCase("en-US"), email, nameMatch[0], match[0],
  ])).digest("hex");
  return { status: "REVIEW_REQUIRED", reason: "EXPLICIT_NAMED_EMAIL_ON_PROFILE",
    emailNormalized: email, profileUrl: url, evidenceDigest: digest,
    personEmailLinked: false, usableAsContact: false, onboardingEligible: false };
}

export async function inspectAndStoreDirectEmailObservation(db, {
  workspaceId, ownerId, candidateId,
}, { retrieve = retrieveCitedPublicPage, now = () => new Date() } = {}) {
  if (![workspaceId, ownerId, candidateId].every(v => typeof v === "string" && ID.test(v)) ||
      typeof retrieve !== "function" || typeof now !== "function") {
    throw new TypeError("Valid candidate scope required");
  }
  const candidate = await db.candidate.findFirst({
    where: { id: candidateId, workspaceId },
    select: { id: true, name: true, email: true, expertProfileUrl: true },
  });
  if (!candidate) return { code: "CANDIDATE_NOT_FOUND", status: 404 };
  const profileUrl = publicCitationUrl(candidate.expertProfileUrl);
  if (!profileUrl || !normalizedEmail(candidate.email)) {
    return { status: 409, code: "DIRECT_PERSON_EMAIL_EVIDENCE_MISSING" };
  }
  let page;
  try { page = await retrieve(profileUrl); }
  catch { return { status: 409, code: "PROFILE_INSPECTION_UNAVAILABLE" }; }
  const finding = classifyExplicitPersonEmailPage(candidate, page);
  if (finding.status !== "REVIEW_REQUIRED") {
    return { status: 409, code: finding.reason };
  }
  const inspectedAt = now();
  if (!(inspectedAt instanceof Date) || !Number.isFinite(inspectedAt.getTime())) {
    throw new TypeError("Invalid clock");
  }
  return db.$transaction(async tx => {
    if (!await lockActiveWorkspaceMembership(tx, { workspaceId, userId: ownerId })) {
      return { status: 403, code: "WORKSPACE_ACCESS_REVOKED" };
    }
    // Fences concurrent profile/email/identity updates and candidate deletion.
    const rows = await tx.$queryRaw`
      SELECT "id", "name", "email", "expertProfileUrl" FROM "Candidate"
      WHERE "id" = ${candidateId} AND "workspaceId" = ${workspaceId}
      FOR UPDATE`;
    if (rows.length !== 1) return { status: 404, code: "CANDIDATE_NOT_FOUND" };
    const current = rows[0];
    if (normalizedEmail(current.email) !== finding.emailNormalized ||
        current.name !== candidate.name ||
        publicCitationUrl(current.expertProfileUrl) !== finding.profileUrl) {
      return { status: 409, code: "CANDIDATE_CHANGED_RECHECK_REQUIRED" };
    }
    // A team or shared source is not an individual profile: refuse automatic
    // association when another candidate also uses this exact profile URL.
    const shared = await tx.candidate.count({ where: {
      workspaceId, expertProfileUrl: current.expertProfileUrl, id: { not: candidateId },
    } });
    if (shared) return { status: 409, code: "SHARED_PROFILE_REVIEW_REQUIRED" };
    await tx.candidateDirectEmailObservation.upsert({
      where: { candidateId },
      create: { workspaceId, candidateId, personName: candidate.name,
        emailNormalized: finding.emailNormalized,
        profileUrl: finding.profileUrl, evidenceDigest: finding.evidenceDigest,
        inspectedAt, status: "REVIEW_REQUIRED" },
      update: { workspaceId, personName: candidate.name,
        emailNormalized: finding.emailNormalized,
        profileUrl: finding.profileUrl, evidenceDigest: finding.evidenceDigest,
        inspectedAt, status: "REVIEW_REQUIRED" },
    });
    await tx.auditEvent.create({ data: {
      actorId: ownerId, action: "candidate.direct-email-evidence.inspected",
      entityId: candidateId, metadata: {
        workspaceId, evidenceDigest: finding.evidenceDigest,
        status: "REVIEW_REQUIRED", usableAsContact: false,
      },
    } });
    return { status: 200, code: "DIRECT_EMAIL_EVIDENCE_REVIEW_REQUIRED",
      observation: { sourceUrl: finding.profileUrl, inspectedAt,
        status: "REVIEW_REQUIRED" },
      personEmailLinked: false, usableAsContact: false,
      onboardingEligible: false, sendingEnabled: false };
  });
}

// Reads must never trust a snapshot for a later changed address or profile.
export function visibleDirectEmailObservation(candidate, observation) {
  if (!candidate || !observation ||
      normalizedEmail(candidate.email) !== observation.emailNormalized ||
      candidate.name !== observation.personName ||
      publicCitationUrl(candidate.expertProfileUrl) !== observation.profileUrl ||
      observation.status !== "REVIEW_REQUIRED") return null;
  return Object.freeze({ status: "REVIEW_REQUIRED",
    sourceUrl: observation.profileUrl, inspectedAt: observation.inspectedAt,
    personEmailLinked: false, usableAsContact: false,
    onboardingEligible: false });
}
