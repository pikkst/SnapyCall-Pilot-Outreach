// An authorized person-source task is a distinct paid research unit.
// Claim, owner-wide budget reservation and quota are one atomic transaction.
// Existing ResearchCampaignTask and Candidate acceptance contracts are untouched.
import { randomUUID } from "node:crypto";
import { isWorkspaceId, lockActiveWorkspaceMembership }
  from "./workspace-access.js";
import { personSourceFingerprint } from "./research-person-source-queue.js";
import { personSourceJobSnapshot } from "./research-person-source-approval.js";
import { requireResearchPriceEnvelope } from "./research-price-policy.js";
import { lockedResearchPreferences, reserveResearchLease,
  reserveResearchAttempt, releaseResearchLease } from "./research-quota.js";
import { reserveOwnerSpend, settleOwnerSpend } from "./research-budget.js";
import { normalizeCampaignObservations } from "./research-campaign-observations.js";
import { isDirectPublicProfileUrl } from "./research-observation-email.js";
import { researchCandidates } from "./ai-research.js";
import { retrieveCitedPublicPage } from "./research-public-pages.js";
import { inspectNamedPublicContactEvidence } from "./research-linked-contact-proof.js";
import { classifyPersonSourceInspectionFailure }
  from "./research-person-source-evidence.js";
import { repeatedUnavailableSourceDomains } from "./research-source-domain-feedback.js";
import { resolveCampaignResearchExecution } from "./research-campaign-worker.js";
import { decryptKey } from "./security.js";

const LEASE_MS = 120_000;
const MAX_JOBS = 250;
const sourceFields = {
  id: true, name: true, category: true, citationUrl: true,
  groundingStatus: true, groundingResolvedUrl: true,
  groundingProvenance: true, emailTriageStatus: true,
};
const jobFields = {
  id: true, campaignId: true, observationId: true, status: true,
  evidenceFingerprint: true, reason: true, attempts: true,
  leaseToken: true, leaseUntil: true,
};
export class PersonSourceExecutionBlocked extends Error {
  constructor(code) {
    super("Approved source research is not executable");
    this.name = "PersonSourceExecutionBlocked";
    this.code = code;
  }
}
function validateScope({ campaignId, workspaceId, ownerId }, now) {
  if (![campaignId, workspaceId, ownerId].every(isWorkspaceId) ||
      !(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("Verified person-source campaign and clock required");
  }
}

// Prioritize the already-inspected but unqualified individual evidence first,
// then unresolved individual sources, and only then shared directory citations.
// The immutable job snapshot, id ordering and owner budget remain unchanged.
// No prior attempted job can be selected or replayed.
const PERSON_SOURCE_PRIORITY = Object.freeze({
  ALTERNATE_EMAIL_SOURCE: 0,
  PERSON_SOURCE_REQUIRED: 1,
  SHARED_SOURCE: 2,
});
// Conservative campaign-local feedback only: completed source research is
// not evidence of success unless independent person-email verification passed.
// Require four terminal observations of the SAME reason before changing the
// existing priority. No host inference, historical cross-tenant data, or
// mutation of the approved job manifest.
const PRIORITY_MIN_SAMPLE = 4;
const FINISHED_SOURCE_STATUSES = new Set(["COMPLETED", "VERIFIED"]);
function sourcePriorityAdjustments(jobs) {
  const groups = new Map();
  for (const job of jobs) {
    if (!Object.hasOwn(PERSON_SOURCE_PRIORITY, job?.reason) ||
        !FINISHED_SOURCE_STATUSES.has(job.status) ||
        job.attempts < 1) continue;
    const prior = groups.get(job.reason) ?? { total: 0, verified: 0 };
    prior.total++;
    if (job.status === "VERIFIED") prior.verified++;
    groups.set(job.reason, prior);
  }
  const adjustments = new Map();
  for (const [reason, outcome] of groups) {
    if (outcome.total < PRIORITY_MIN_SAMPLE) continue;
    // One positive observation can be noise. Require two verified outcomes
    // for promotion, while four zero-yield calls permit a mild demotion.
    if (outcome.verified >= 2) adjustments.set(reason, -5);
    else if (outcome.verified === 0) adjustments.set(reason, 5);
  }
  return adjustments;
}
export function selectNextPersonSourceJob(jobs) {
  if (!Array.isArray(jobs) || jobs.length > MAX_JOBS) {
    throw new TypeError("Bounded persisted person source jobs required");
  }
  const adjustments = sourcePriorityAdjustments(jobs);
  let selected = null;
  let selectedRank = Infinity;
  for (const job of jobs) {
    if (job?.status !== "QUEUED" || job.attempts !== 0 ||
        typeof job.observationId !== "string") continue;
    // Existing reason tiers remain the default. Adjustments can cross one
    // tier only with adequate campaign-local evidence; never remove a job.
    const rank = (PERSON_SOURCE_PRIORITY[job.reason] ?? 3) * 4 +
      (adjustments.get(job.reason) ?? 0);
    if (rank < selectedRank ||
        (rank === selectedRank &&
          job.observationId < selected.observationId)) {
      selected = job;
      selectedRank = rank;
    }
  }
  return selected;
}

// Target the *named person's* published professional contact evidence.
// One approved source job still makes exactly one provider search. Results are
// untrusted source hints; independent HTTPS inspection and exact-person email
// attribution remain mandatory. No inferred addresses or contact acceptance.
const SOURCE_CATEGORY_SEARCH = Object.freeze({
  AI_AUTOMATION: "AI automation consultant",
  COACHING: "professional coach",
  MARKETING_GROWTH: "marketing growth consultant",
  BUSINESS_STRATEGY: "business strategy consultant",
});
// The approved queue already distinguishes missing individual evidence
// from shared sources. Reuse that trusted reason to select ONE bounded query,
// not additional provider calls or a guessed company/website affiliation.
const SOURCE_SEARCH_INTENT = Object.freeze({
  ALTERNATE_EMAIL_SOURCE: "email contact",
  PERSON_SOURCE_REQUIRED: "profile contact email",
  SHARED_SOURCE: "team staff contact email",
});
export function personSourceSearchQuery({ name, category, reason = "ALTERNATE_EMAIL_SOURCE" }) {
  if (typeof name !== "string" || name.length < 5 || name.length > 160 ||
      /[\r\n]/.test(name) || !SOURCE_CATEGORY_SEARCH[category] ||
      !Object.hasOwn(SOURCE_SEARCH_INTENT, reason)) {
    throw new TypeError("A valid named professional search is required");
  }
  const safeName = name.normalize("NFKC").replace(/"/g, " ").replace(/\s+/g, " ").trim();
  if (safeName.length < 5) throw new TypeError("A named professional is required");
  // Keep the exact identity and category in every query. In particular,
  // shared-source work looks for the person's official team/contact record
  // rather than guessing an employer, domain or personal email pattern.
  return '"' + safeName + '" ' + SOURCE_SEARCH_INTENT[reason] + " " +
    SOURCE_CATEGORY_SEARCH[category] + " official";
}

// This stage uses a frozen manifest of observation fingerprints rather than
// trusting the statuses returned by the browser or cached running task.
export async function claimPersonSourceJob(db, {
  campaignId, workspaceId, ownerId, provider, model,
}, { now = new Date() } = {}) {
  validateScope({ campaignId, workspaceId, ownerId }, now);
  const price = requireResearchPriceEnvelope({ provider, model });
  return db.$transaction(async tx => {
    if (!await lockActiveWorkspaceMembership(tx, { workspaceId, userId: ownerId })) {
      return { status: "BLOCKED", code: "WORKSPACE_ACCESS_REVOKED" };
    }
    const campaigns = await tx.$queryRaw`
      SELECT "id","status" FROM "ResearchCampaign"
      WHERE "id" = ${campaignId} AND "workspaceId" = ${workspaceId}
        AND "ownerId" = ${ownerId} FOR UPDATE`;
    if (campaigns.length !== 1) {
      return { status: "BLOCKED", code: "CAMPAIGN_NOT_FOUND" };
    }
    if (!["PARTIAL", "COMPLETED"].includes(campaigns[0].status)) {
      return { status: "BLOCKED", code: "DISCOVERY_NOT_TERMINAL" };
    }
    const initial = await tx.researchPersonSourceApproval.findUnique({
      where: { campaignId },
    });
    // A new cycle is eligible only after the initial approval has reached
    // a terminal state. Never reauthorize an old attempted job.
    const continuation = initial &&
      ["COMPLETED", "PARTIAL_BUDGET"].includes(initial.status)
      ? await tx.researchPersonSourceCycle.findFirst({
        where: { campaignId, status: { in: ["APPROVED", "RUNNING"] } },
        orderBy: { cycleIndex: "desc" },
      }) : null;
    const approval = continuation ?? initial;
    const cycleIndex = continuation?.cycleIndex ?? 0;
    if (!approval || approval.workspaceId !== workspaceId ||
        approval.ownerId !== ownerId ||
        !["APPROVED", "RUNNING"].includes(approval.status)) {
      return { status: "BLOCKED", code: "PERSON_SOURCE_APPROVAL_REQUIRED" };
    }
    if (continuation) {
      const full = await tx.researchFullRun.findUnique({
        where: { campaignId },
      });
      if (!full || full.workspaceId !== workspaceId ||
          full.ownerId !== ownerId || full.status !== "SOURCE_RUNNING" ||
          !(full.expiresAt instanceof Date) || full.expiresAt <= now) {
        return { status: "BLOCKED", code: "SOURCE_CONTINUATION_NOT_ACTIVE" };
      }
      // All prior cycles are immutable and only one can dispatch at a time.
      const otherActive = await tx.researchPersonSourceCycle.count({
        where: { campaignId, cycleIndex: { not: cycleIndex },
          status: { in: ["APPROVED", "RUNNING"] } },
      });
      if (otherActive) return { status: "BLOCKED",
        code: "MULTIPLE_SOURCE_CYCLES_ACTIVE" };
    }
    if (!(approval.expiresAt instanceof Date) || approval.expiresAt <= now) {
      return { status: "BLOCKED", code: "PERSON_SOURCE_APPROVAL_EXPIRED" };
    }
    if (approval.provider !== provider || approval.model !== model ||
        approval.priceVersion !== price.priceVersion ||
        approval.worstCasePerCallCents !== price.worstCaseCents) {
      return { status: "BLOCKED", code: "PERSON_SOURCE_PRICE_CHANGED" };
    }
    const jobs = await tx.researchPersonSourceJob.findMany({
      where: continuation
        ? { campaignId, cycleIndex }
        : { campaignId }, select: jobFields,
      orderBy: { observationId: "asc" }, take: MAX_JOBS + 1,
    });
    if (jobs.length !== approval.eligibleJobCount || jobs.length > MAX_JOBS) {
      return { status: "BLOCKED", code: "SOURCE_JOB_SNAPSHOT_CHANGED" };
    }
    let digest;
    try { digest = personSourceJobSnapshot(jobs.map(job =>
      ({ ...job, status: "QUEUED" }))); }
    catch { return { status: "BLOCKED", code: "SOURCE_JOB_SNAPSHOT_CHANGED" }; }
    if (digest !== approval.jobSnapshotHash) {
      return { status: "BLOCKED", code: "SOURCE_JOB_SNAPSHOT_CHANGED" };
    }
    // Never dispatch a new call before a previous possibly billed call has
    // finished and been reconciled. Expired leases are NOT auto-retried.
    if (jobs.some(job => ["RUNNING", "PAUSED"].includes(job.status))) {
      return { status: "BLOCKED", code: "SOURCE_JOB_UNSETTLED" };
    }
    if (continuation) {
      // Earlier uncertain billing is globally blocking, not just blocking
      // a single cycle's job selection.
      const unresolved = await tx.researchPersonSourceJob.count({
        where: { campaignId, status: { in: ["RUNNING", "PAUSED"] } },
      });
      if (unresolved) return { status: "BLOCKED", code: "SOURCE_JOB_UNSETTLED" };
    }
    if (approval.startedCalls >= approval.maxCalls ||
        approval.committedWorstCaseCents + price.worstCaseCents >
          approval.maxWorstCaseCents) {
      return { status: "BLOCKED", code: "SOURCE_APPROVED_SPEND_EXHAUSTED" };
    }
    const queued = selectNextPersonSourceJob(jobs);
    if (!queued) return { status: "IDLE", code: "NO_SOURCE_JOB_READY" };
    const observation = await tx.researchCampaignObservation.findFirst({
      where: { campaignId, id: queued.observationId },
      select: sourceFields,
    });
    if (!observation || personSourceFingerprint(observation) !==
        queued.evidenceFingerprint) {
      return { status: "BLOCKED", code: "SOURCE_JOB_EVIDENCE_CHANGED" };
    }
    if (typeof observation.name !== "string" ||
        observation.name.length < 5 || observation.name.length > 160 ||
        /[\r\n]/.test(observation.name) ||
        !["AI_AUTOMATION", "COACHING", "MARKETING_GROWTH",
          "BUSINESS_STRATEGY"].includes(observation.category)) {
      return { status: "BLOCKED", code: "SOURCE_JOB_IDENTITY_INVALID" };
    }
    const preferences = await lockedResearchPreferences(tx, ownerId);
    const leaseId = await reserveResearchLease(tx, {
      workspaceId, userId: ownerId, maxConcurrent: preferences.maxConcurrent,
    });
    const reservationId = randomUUID();
    await reserveOwnerSpend(tx, {
      ownerId, workspaceId, reservationId,
      worstCaseCents: price.worstCaseCents, now,
    });
    await reserveResearchAttempt(tx, {
      workspaceId, userId: ownerId,
      dailyLimit: preferences.dailyLimit, now,
    });
    // Continuation authorizations live in ResearchPersonSourceCycle, not the
    // original approval table. Update the correct row under the same campaign
    // lock, budget reservation and job CAS transaction.
    const approvalWhere = { id: approval.id, campaignId, workspaceId, ownerId,
      status: { in: ["APPROVED", "RUNNING"] }, expiresAt: { gt: now },
      startedCalls: { lt: approval.maxCalls },
      committedWorstCaseCents: { lte:
        approval.maxWorstCaseCents - price.worstCaseCents } };
    const approvalData = { status: "RUNNING",
      startedCalls: { increment: 1 },
      committedWorstCaseCents: { increment: price.worstCaseCents } };
    const updated = continuation
      ? await tx.researchPersonSourceCycle.updateMany({
        where: { ...approvalWhere, cycleIndex },
        data: approvalData,
      })
      : await tx.researchPersonSourceApproval.updateMany({
        where: approvalWhere, data: approvalData,
      });
    if (updated.count !== 1) {
      throw new PersonSourceExecutionBlocked("SOURCE_APPROVAL_CONFLICT");
    }
    const leaseToken = randomUUID();
    const leaseUntil = new Date(now.getTime() + LEASE_MS);
    const claimed = await tx.researchPersonSourceJob.updateMany({
      where: { id: queued.id, campaignId, observationId: queued.observationId,
        cycleIndex, status: "QUEUED", attempts: 0, leaseToken: null,
        evidenceFingerprint: queued.evidenceFingerprint },
      data: { status: "RUNNING", attempts: { increment: 1 },
        leaseToken, leaseUntil, spendReservationId: reservationId,
        researchLeaseId: leaseId },
    });
    if (claimed.count !== 1) {
      throw new PersonSourceExecutionBlocked("SOURCE_JOB_CLAIM_CONFLICT");
    }
    await tx.auditEvent.create({ data: {
      actorId: ownerId, entityId: queued.id,
      action: "research.person-source.spend.reserved",
      metadata: { workspaceId, campaignId, provider, model,
        priceVersion: price.priceVersion, worstCaseCents: price.worstCaseCents,
        reservationId, cycleIndex, automaticBillableReplay: false,
        contactCreated: false, sendingEnabled: false },
    } });
    return {
      status: "CLAIMED", jobId: queued.id, observationId: queued.observationId,
      campaignId, workspaceId, ownerId, name: observation.name,
      category: observation.category, provider, model,
      leaseToken, leaseUntil, leaseId, reservationId,
      worstCaseCents: price.worstCaseCents,
      query: personSourceSearchQuery({ ...observation, reason: queued.reason }),
    };
  });
}

// Candidate matching is a conservative provider-CITATION hint only, not
// independent identity, address, mailbox or legal-basis verification.
export function proposedPersonSource(preview, { name, category }) {
  if (typeof name !== "string" || typeof category !== "string") {
    throw new TypeError("Expected named person");
  }
  const entries = normalizeCampaignObservations(preview, 5);
  const normalizeName = value => value.normalize("NFKC")
    .replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
  const exact = entries.filter(entry =>
    normalizeName(entry.name) === normalizeName(name) &&
    entry.category === category &&
    isDirectPublicProfileUrl(entry.citationUrl));
  const urls = [...new Set(exact.map(entry => entry.citationUrl))];
  return urls.length === 1 ? urls[0] : null;
}

// Inspect at most three provider-cited exact-person sources within ONE
// already authorized source job. Local HTTPS reads are not additional AI
// searches, and their results never create a contact or grant sending consent.
// Multiple independently verified, conflicting mailboxes fail closed.
const SOURCE_INSPECTION_REASONS = new Set([
  "SOURCE_NO_MATCHING_CITED_PROFILE",
  "SOURCE_ALL_PAGES_UNAVAILABLE",
  "SOURCE_NO_NAMED_EMAIL_EVIDENCE",
  "SOURCE_CONFLICTING_PERSON_EMAILS",
  "SOURCE_MIXED_UNQUALIFIED",
  "SOURCE_NAMED_EMAIL_SOURCE_SELECTED",
]);

// Only trusted reader error codes enter privacy-safe campaign diagnostics.
// Never record exception messages, URLs, hostnames or source page contents.
const SOURCE_ACCESS_FAILURE_FIELDS = Object.freeze([
  "robots", "redirect", "dns", "http", "timeout", "content", "linked", "other",
]);
const CONTENT_FAILURE_FIELDS = Object.freeze([
  "mime", "encoding", "status", "size", "other",
]);
function emptyContentFailures() {
  return Object.fromEntries(CONTENT_FAILURE_FIELDS.map(key => [key, 0]));
}
function sourceContentFailureSubtype(error) {
  const code = classifyPersonSourceInspectionFailure(error);
  if (code === "PUBLIC_PAGE_TOO_LARGE") return "size";
  if (code !== "PUBLIC_PAGE_CONTENT_REJECTED") return "other";
  return CONTENT_FAILURE_FIELDS.includes(error?.contentFailureSubtype)
    ? error.contentFailureSubtype : "other";
}
function emptySourceAccessFailures() {
  return Object.fromEntries(SOURCE_ACCESS_FAILURE_FIELDS.map(key => [key, 0]));
}
function sourceAccessFailureBucket(error) {
  switch (classifyPersonSourceInspectionFailure(error)) {
    case "PUBLIC_PAGE_ROBOTS_REJECTED": return "robots";
    case "PUBLIC_PAGE_REDIRECT_REJECTED": return "redirect";
    case "PUBLIC_PAGE_DNS_REJECTED":
    case "PUBLIC_PAGE_NO_VALID_IPV4": return "dns";
    case "PUBLIC_PAGE_HTTP_REJECTED": return "http";
    case "PUBLIC_PAGE_TIMEOUT": return "timeout";
    case "PUBLIC_PAGE_CONTENT_REJECTED":
    case "PUBLIC_PAGE_TOO_LARGE": return "content";
    default: return "other";
  }
}

// Prefer an exact person's published contact/profile path among already
// provider-cited, exact-target candidate URLs. URL structure is only a
// scheduling hint: it never establishes source authority or email evidence.
// Preserve original order on ties and never add or alter a cited URL.
export function rankCitedPersonSourceUrls(urls, personName) {
  if (!Array.isArray(urls) || urls.length > 5 ||
      typeof personName !== "string" || personName.length > 160) {
    throw new TypeError("Bounded exact-person URL hints required");
  }
  const slug = personName.normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
  const scored = urls.map((value, index) => {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new TypeError("HTTPS source required");
    const path = decodeURIComponent(url.pathname).toLocaleLowerCase("en-US")
      .replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
    const exactPerson = slug.length >= 5 &&
      (path === slug || path.endsWith("-" + slug) ||
        path.startsWith(slug + "-") || path.includes("-" + slug + "-"));
    const contactPath = /(?:^|[-/])(contact|team|staff|people|experts|speakers)(?:[-/]|$)/i
      .test(url.pathname);
    const genericPath = /(?:^|[-/])(blog|articles|news|events)(?:[-/]|$)/i
      .test(url.pathname);
    return { value, index, score: (exactPerson ? 4 : 0) +
      (contactPath ? 2 : 0) - (genericPath ? 2 : 0) };
  });
  return scored.sort((a, b) => b.score - a.score || a.index - b.index)
    .map(item => item.value);
}

// Returns only coarse, bounded operational diagnostics. URLs, names, page
// text and email addresses must never enter job status or audit metadata.
// The independent downstream verifier remains the only proof persistence path.
export async function inspectEvidenceBackedPersonSources(preview, subject, {
  retrieve = retrieveCitedPublicPage, mayFollowLinked = () => true,
} = {}) {
  if (typeof retrieve !== "function" ||
      typeof mayFollowLinked !== "function" ||
      typeof subject?.name !== "string" ||
      typeof subject?.category !== "string") {
    throw new TypeError("Trusted named source inspection required");
  }
  const entries = normalizeCampaignObservations(preview, 5);
  const name = value => value.normalize("NFKC")
    .replace(/\\s+/g, " ").trim().toLocaleLowerCase("en-US");
  const cited = new Set((Array.isArray(preview?.sources) ? preview.sources : [])
    .map(item => isDirectPublicProfileUrl(item?.url)).filter(Boolean));
  const urls = [...new Set(entries.filter(entry =>
    name(entry.name) === name(subject.name) &&
    entry.category === subject.category &&
    cited.has(isDirectPublicProfileUrl(entry.citationUrl)))
    .map(entry => isDirectPublicProfileUrl(entry.citationUrl))
    .filter(Boolean))];
  const prioritizedUrls = rankCitedPersonSourceUrls(urls, subject.name).slice(0, 3);
  const diagnostics = {
    cited: prioritizedUrls.length, attempted: 0, unavailable: 0,
    noNamedEmail: 0, verified: 0, conflicting: false,
    accessFailures: emptySourceAccessFailures(),
    contentFailures: emptyContentFailures(),
  };
  let verified = null;
  let linkedAttempted = false;
  for (const url of prioritizedUrls) {
    diagnostics.attempted++;
    let inspected;
    try {
      inspected = await inspectNamedPublicContactEvidence({
        url, name: subject.name, retrieve,
        // One additional public read per paid job, if enough lease remains.
        allowLinked: !linkedAttempted && mayFollowLinked(),
      });
    } catch (error) {
      diagnostics.unavailable++;
      const category = sourceAccessFailureBucket(error);
      diagnostics.accessFailures[category]++;
      if (category === "content") {
        diagnostics.contentFailures[sourceContentFailureSubtype(error)]++;
      }
      continue;
    }
    if (inspected.linkedAttempted) linkedAttempted = true;
    const proof = inspected.evidence;
    if (!proof) {
      if (inspected.linkedUnavailable) {
        diagnostics.unavailable++;
        diagnostics.accessFailures.linked++;
      } else diagnostics.noNamedEmail++;
      continue;
    }
    diagnostics.verified++;
    if (verified && verified.email !== proof.emailNormalized) {
      diagnostics.conflicting = true;
    }
    if (!verified) verified = { url, email: proof.emailNormalized };
  }
  const reason = diagnostics.conflicting
    ? "SOURCE_CONFLICTING_PERSON_EMAILS"
    : verified ? "SOURCE_NAMED_EMAIL_SOURCE_SELECTED"
    : diagnostics.cited === 0 ? "SOURCE_NO_MATCHING_CITED_PROFILE"
    : diagnostics.unavailable === diagnostics.attempted
      ? "SOURCE_ALL_PAGES_UNAVAILABLE"
    : diagnostics.noNamedEmail === diagnostics.attempted
      ? "SOURCE_NO_NAMED_EMAIL_EVIDENCE"
    : "SOURCE_MIXED_UNQUALIFIED";
  return {
    proposedUrl: verified && !diagnostics.conflicting ? verified.url : null,
    diagnostics: Object.freeze({ ...diagnostics,
      accessFailures: Object.freeze({ ...diagnostics.accessFailures }),
      contentFailures: Object.freeze({ ...diagnostics.contentFailures }), reason }),
  };
}

// Preserve the original public source-selection API for existing consumers.
export async function selectEvidenceBackedPersonSource(preview, subject, options) {
  const result = await inspectEvidenceBackedPersonSources(preview, subject, options);
  return result.proposedUrl;
}

// Finish is a single fenced DB transaction, including conservative ledger
// settlement. If the fence expired after dispatch, only explicit
// reconciliation may decide next steps; never replay the paid provider.
export async function finishPersonSourceJob(db, claim, {
  proposedUrl = null, providerInvoked = true, code = null,
  inspection = null,
}, { now = new Date() } = {}) {
  validateScope(claim, now);
  if (!isWorkspaceId(claim.jobId) ||
      typeof claim.leaseToken !== "string" ||
      typeof claim.reservationId !== "string" ||
      typeof providerInvoked !== "boolean" ||
      (proposedUrl !== null && !isDirectPublicProfileUrl(proposedUrl))) {
    throw new TypeError("Valid fenced source-job completion required");
  }
  if (inspection !== null && (
      !inspection || typeof inspection !== "object" ||
      Array.isArray(inspection) ||
      Object.keys(inspection).sort().join(",") !==
        "accessFailures,attempted,cited,conflicting,contentFailures,noNamedEmail,reason,unavailable,verified" ||
      !inspection.contentFailures ||
      typeof inspection.contentFailures !== "object" ||
      Array.isArray(inspection.contentFailures) ||
      Object.keys(inspection.contentFailures).sort().join(",") !==
        CONTENT_FAILURE_FIELDS.slice().sort().join(",") ||
      CONTENT_FAILURE_FIELDS.some(key =>
        !Number.isInteger(inspection.contentFailures[key]) ||
        inspection.contentFailures[key] < 0 ||
        inspection.contentFailures[key] > 3) ||
      CONTENT_FAILURE_FIELDS.reduce((sum, key) =>
        sum + inspection.contentFailures[key], 0) !==
        inspection.accessFailures?.content ||
      !inspection.accessFailures ||
      typeof inspection.accessFailures !== "object" ||
      Array.isArray(inspection.accessFailures) ||
      Object.keys(inspection.accessFailures).sort().join(",") !==
        SOURCE_ACCESS_FAILURE_FIELDS.slice().sort().join(",") ||
      SOURCE_ACCESS_FAILURE_FIELDS.some(key =>
        !Number.isInteger(inspection.accessFailures[key]) ||
        inspection.accessFailures[key] < 0 ||
        inspection.accessFailures[key] > 3) ||
      SOURCE_ACCESS_FAILURE_FIELDS.reduce((sum, key) =>
        sum + inspection.accessFailures[key], 0) !== inspection.unavailable ||
      !SOURCE_INSPECTION_REASONS.has(inspection.reason) ||
      typeof inspection.conflicting !== "boolean" ||
      ["attempted", "cited", "unavailable", "noNamedEmail", "verified"]
        .some(key => !Number.isInteger(inspection[key]) ||
          inspection[key] < 0 || inspection[key] > 3) ||
      inspection.attempted !== inspection.cited ||
      inspection.unavailable + inspection.noNamedEmail +
        inspection.verified !== inspection.attempted ||
      (inspection.conflicting && inspection.verified < 2)
    )) throw new TypeError("Bounded source inspection outcome required");
  const result = await db.$transaction(async tx => {
    const authorized = await lockActiveWorkspaceMembership(tx, {
      workspaceId: claim.workspaceId, userId: claim.ownerId,
    });
    const campaigns = await tx.$queryRaw`
      SELECT "id" FROM "ResearchCampaign"
      WHERE "id" = ${claim.campaignId}
        AND "workspaceId" = ${claim.workspaceId}
        AND "ownerId" = ${claim.ownerId} FOR UPDATE`;
    if (campaigns.length !== 1) {
      return { status: "RECONCILIATION_REQUIRED", code: "CAMPAIGN_NOT_FOUND" };
    }
    const job = await tx.researchPersonSourceJob.findFirst({
      where: { id: claim.jobId, campaignId: claim.campaignId,
        observationId: claim.observationId },
    });
    if (!job || job.status !== "RUNNING" ||
        job.leaseToken !== claim.leaseToken ||
        job.spendReservationId !== claim.reservationId ||
        !(job.leaseUntil instanceof Date) || job.leaseUntil <= now) {
      return { status: "RECONCILIATION_REQUIRED", code: "SOURCE_JOB_LEASE_EXPIRED" };
    }
    // Source attribution is not assumed from a provider-cited hit. Check
    // collisions with every already-observed profile before staging a hint.
    let source = proposedUrl;
    let sourceCollision = false;
    if (source) {
      const collisions = await tx.researchCampaignObservation.count({
        where: { campaignId: claim.campaignId,
          id: { not: claim.observationId },
          OR: [{ citationUrl: source }, { groundingResolvedUrl: source }] },
      });
      const otherProposals = await tx.researchPersonSourceJob.count({
        where: { campaignId: claim.campaignId, id: { not: claim.jobId },
          proposedSourceUrl: source },
      });
      if (collisions || otherProposals) {
        source = null;
        sourceCollision = true;
      }
    }
    const state = authorized && providerInvoked && code !== "BILLING_UNCERTAIN"
      ? "COMPLETED" : "PAUSED";
    const reason = !authorized ? "WORKSPACE_ACCESS_REVOKED" :
      !providerInvoked ? "PROVIDER_NOT_DISPATCHED" :
      code === "BILLING_UNCERTAIN" ? "BILLING_UNCERTAIN" :
      source ? "SOURCE_CITATION_NEEDS_INSPECTION" :
      sourceCollision ? "SOURCE_SELECTED_COLLISION" :
      inspection?.reason && inspection.reason !== "SOURCE_NAMED_EMAIL_SOURCE_SELECTED"
        ? inspection.reason : "NO_UNIQUE_DIRECT_SOURCE";
    await settleOwnerSpend(tx, {
      ownerId: claim.ownerId, workspaceId: claim.workspaceId,
      reservationId: claim.reservationId,
      // No certified per-source cost receipt exists; settle the complete
      // pre-approved worst-case amount for any potentially billed call.
      actualCents: providerInvoked ? null : 0,
    });
    const changed = await tx.researchPersonSourceJob.updateMany({
      where: { id: claim.jobId, campaignId: claim.campaignId,
        status: "RUNNING", leaseToken: claim.leaseToken,
        leaseUntil: { gt: now }, spendReservationId: claim.reservationId },
      data: { status: state, lastErrorCode: reason,
        proposedSourceUrl: authorized ? source : null,
        leaseToken: null, leaseUntil: null },
    });
    if (changed.count !== 1) {
      throw new PersonSourceExecutionBlocked("SOURCE_JOB_COMMIT_CONFLICT");
    }
    await tx.auditEvent.create({ data: {
      actorId: claim.ownerId, entityId: claim.jobId,
      action: "research.person-source.attempt.settled",
      metadata: { workspaceId: claim.workspaceId, campaignId: claim.campaignId,
        status: state, code: reason, providerInvoked,
        ...(inspection ? { sourceInspection: inspection } : {}),
        conservativeCharge: providerInvoked, automaticBillableReplay: false,
        contactCreated: false, sendingEnabled: false },
    } });
    return { status: state, code: reason, sourceProposed: !!source,
      sendingEnabled: false };
  });
  if (result.status !== "RECONCILIATION_REQUIRED") {
    // Concurrency release is idempotent; a failure leaves the finite TTL lease.
    try {
      await releaseResearchLease(db, claim.leaseId,
        claim.workspaceId, claim.ownerId);
    } catch {
      return { status: "RECONCILIATION_REQUIRED",
        code: "SOURCE_CONCURRENCY_RELEASE_UNCONFIRMED" };
    }
  }
  return result;
}

// This executor performs one authorized provider search. It NEVER silently
// retries, accepts a Candidate, sends a message, or promotes a citation into
// person-specific proof without independent page inspection.
export async function runOnePersonSourceJob(db, {
  campaignId, workspaceId, ownerId, encryptionKey,
}, {
  now = () => new Date(), search = researchCandidates,
  decrypt = decryptKey,
  tavilyApiKey = process.env.TAVILY_API_KEY,
  tavilyEnabled = process.env.TAVILY_DUAL_PROVIDER_ENABLED === "true",
  accountCapVerified = process.env.TAVILY_ACCOUNT_CAP_VERIFIED === "true",
  retrieve = retrieveCitedPublicPage,
} = {}) {
  if (typeof encryptionKey !== "string" || encryptionKey.length < 16 ||
      typeof search !== "function" || typeof decrypt !== "function" ||
      typeof retrieve !== "function") {
    throw new TypeError("Trusted source worker configuration required");
  }
  const setting = await db.aiSetting.findUnique({ where: { ownerId } });
  if (!setting?.provider || !setting.model) {
    return { status: "BLOCKED", code: "RESEARCH_AI_SETTINGS_REQUIRED" };
  }
  // Reuse the discovery executor's exact provider-specific billing contract.
  // Gemini 3's approved tariff is Tavily Basic + text-only Gemini, NEVER
  // Google's differently billed grounding search on the same model.
  const price = requireResearchPriceEnvelope({
    provider: setting.provider, model: setting.model,
  });
  const plan = resolveCampaignResearchExecution({
    provider: setting.provider, model: setting.model, price, search,
    tavilyApiKey, tavilyEnabled, accountCapVerified,
  });
  // No paid search is allowed until the owner has a matching immutable
  // source-stage approval. Claim transaction rechecks model and pricing.
  const claim = await claimPersonSourceJob(db, {
    campaignId, workspaceId, ownerId,
    provider: setting.provider, model: setting.model,
  }, { now: now() });
  if (claim.status !== "CLAIMED") return claim;
  let invoked = false;
  let result = null;
  try {
    const live = await db.partnerMembership.findUnique({
      where: { partnerId_userId: { partnerId: workspaceId, userId: ownerId } },
      select: { revokedAt: true, user: { select: { googleSub: true } } },
    });
    if (!live || live.revokedAt || !live.user?.googleSub ||
        now() >= claim.leaseUntil) {
      return await finishPersonSourceJob(db, claim,
        { providerInvoked: false }, { now: now() });
    }
    const key = decrypt(setting.encryptedApiKey, encryptionKey);
    if (typeof key !== "string" || key.length < 8) {
      return await finishPersonSourceJob(db, claim,
        { providerInvoked: false }, { now: now() });
    }
    // Reuse only independently settled failures from THIS campaign.
    // Repeated unavailable public domains are not useful for the same
    // inspection contract. Feed bounded exclusions only to Tavily Basic,
    // never to Gemini instructions, browser inputs, or a new paid call.
    // A failed optional feedback read leaves the previous search behavior.
    let excludeDomains = [];
    if (plan.dualProvider) {
      try {
        const previous = await db.researchPersonSourceJob.findMany({
          where: { campaignId, status: "SOURCE_UNAVAILABLE",
            proposedSourceUrl: { not: null } },
          select: { status: true, proposedSourceUrl: true },
          take: 250,
        });
        excludeDomains = repeatedUnavailableSourceDomains(previous);
      } catch {
        excludeDomains = [];
      }
    }
    invoked = true;
    result = await plan.search({
      query: claim.query, limit: 5, provider: claim.provider,
      model: claim.model, apiKey: key,
      ...(plan.dualProvider ? {
        tavilyApiKey: plan.tavilyApiKey, maxResults: plan.maxResults,
        maxInputTokens: plan.maxInputTokens,
        sourceSubject: { name: claim.name, category: claim.category },
        excludeDomains,
      } : {}),
    });
    const inspected = await inspectEvidenceBackedPersonSources(result, claim,
      { retrieve, mayFollowLinked: () =>
        claim.leaseUntil.getTime() - now().getTime() > 18000 });
    return await finishPersonSourceJob(db, claim,
      { proposedUrl: inspected.proposedUrl, inspection: inspected.diagnostics,
        providerInvoked: true }, { now: now() });
  } catch {
    // Post-dispatch errors are potentially billable. Conserve the full
    // budget and block future calls until explicit operator reconciliation.
    try {
      return await finishPersonSourceJob(db, claim, {
        proposedUrl: null, providerInvoked: invoked,
        code: invoked ? "BILLING_UNCERTAIN" : "PROVIDER_NOT_DISPATCHED",
      }, { now: now() });
    } catch {
      return { status: "RECONCILIATION_REQUIRED",
        code: "SOURCE_JOB_COST_OR_LEASE_UNCERTAIN" };
    }
  }
}
