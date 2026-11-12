// Pilot acquisition domain rules. No network or email side effects.
export const EXPERT_CATEGORIES = Object.freeze({
  AI_AUTOMATION: 30,
  COACHING: 30,
  MARKETING_GROWTH: 20,
  BUSINESS_STRATEGY: 20,
});

export const REGION_PRIORITIES = Object.freeze({
  US: 40,
  UK_IRELAND: 40,
  OTHER_ENGLISH_SPEAKING: 20,
});

// The legal basis and contact channel must be reviewed before outreach.
// A public profile or an email address alone is never sufficient.
export function normalizeCandidate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Candidate must be an object");
  }
  const name = text(input.name, 160);
  const category = text(input.category, 60);
  const sourceUrl = text(input.sourceUrl, 2048);
  if (!name || !Object.hasOwn(EXPERT_CATEGORIES, category)) {
    throw new TypeError("Candidate name and a supported category are required");
  }
  if (!isPublicHttpUrl(sourceUrl)) {
    throw new TypeError("A valid http(s) provenance URL is required");
  }
  const email = text(input.email, 254).toLowerCase();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new TypeError("Invalid email format");
  }
  const region = text(input.region, 40);
  const onlineEnglish = input.onlineEnglish === true;
  const expertProfileUrl = text(input.expertProfileUrl, 2048);
  if (expertProfileUrl && !isPublicHttpUrl(expertProfileUrl)) throw new TypeError("Invalid expert profile URL");
  return Object.freeze({
    name,
    category,
    sourceUrl,
    email: email || null,
    region: Object.hasOwn(REGION_PRIORITIES, region) ? region : null,
    onlineEnglish,
    expertProfileUrl: expertProfileUrl || null,
    profileReviewed: input.profileReviewed === true && Boolean(expertProfileUrl),
    legalBasis: text(input.legalBasis, 120) || null,
    contactReviewed: input.contactReviewed === true,
    suppressed: input.suppressed === true,
  });
}

function text(value, maxLength) {
  if (value == null) return "";
  if (typeof value !== "string") throw new TypeError("Expected a string");
  const result = value.trim();
  if (result.length > maxLength) throw new TypeError("Input exceeds length limit");
  return result;
}

function isPublicHttpUrl(value) {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) ||
        url.username || url.password || !url.hostname.includes(".")) return false;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") ||
        host.endsWith(".local") || host.endsWith(".internal") ||
        /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
        host.includes(":")) return false;
    return true;
  } catch {
    return false;
  }
}

// Campaign target percentages are allocation goals, never candidate merit points.
// Qualification is evidence-gated and intentionally has no numeric score until
// an independently calibrated evidence/scoring contract exists.
export const QUALIFICATION_STAGES = Object.freeze({
  DISCOVERED: "DISCOVERED",
  EVIDENCE_PENDING: "EVIDENCE_PENDING",
  QUALIFIED: "QUALIFIED",
  CONTACT_REVIEW: "CONTACT_REVIEW",
  DRAFT_READY: "DRAFT_READY",
  SUPPRESSED: "SUPPRESSED",
  REJECTED: "REJECTED",
});

export function qualificationDecision(candidate) {
  const c = normalizeCandidate(candidate);
  const discovered = Boolean(candidate.discoveryKey);
  const rejected = ["REJECTED", "DISQUALIFIED"].includes(candidate.status);
  const evidence = [];
  if (!c.onlineEnglish) evidence.push("english_online_requirement_unconfirmed");
  if (discovered && !c.profileReviewed) evidence.push("expert_profile_review_pending");
  if (c.suppressed) {
    return Object.freeze({ stage: QUALIFICATION_STAGES.SUPPRESSED, qualified: false,
      score: null, blockers: Object.freeze(["suppressed"]), evidence: Object.freeze(evidence) });
  }
  if (rejected) {
    return Object.freeze({ stage: QUALIFICATION_STAGES.REJECTED, qualified: false,
      score: null, blockers: Object.freeze(["candidate_rejected"]), evidence: Object.freeze(evidence) });
  }
  if (evidence.length) {
    const untouched = discovered && !c.onlineEnglish && !c.profileReviewed;
    return Object.freeze({ stage: untouched ? QUALIFICATION_STAGES.DISCOVERED : QUALIFICATION_STAGES.EVIDENCE_PENDING,
      qualified: false, score: null, blockers: Object.freeze([...evidence]),
      evidence: Object.freeze(evidence) });
  }
  // Qualification attests to a reviewed online English expert, NOT permission
  // to contact them or a numerical quality/merit ranking.
  const contact = [];
  if (!c.email) contact.push("email_missing");
  if (!c.legalBasis) contact.push("legal_basis_missing");
  if (!c.contactReviewed) contact.push("contact_review_pending");
  const stage = !c.email ? QUALIFICATION_STAGES.QUALIFIED :
    contact.length ? QUALIFICATION_STAGES.CONTACT_REVIEW : QUALIFICATION_STAGES.DRAFT_READY;
  return Object.freeze({ stage, qualified: true, score: null,
    blockers: Object.freeze(contact), evidence: Object.freeze([]) });
}

// Compatibility: consumers may still call scoreCandidate(), but a numeric score
// is unavailable by design; never substitute campaign allocation percentages.
export function scoreCandidate(candidate) {
  const q = qualificationDecision(candidate);
  return Object.freeze({ eligible: q.qualified, score: q.score, reasons: q.blockers, stage: q.stage });
}

// Drafting is a separate, stricter step; email sending is not implemented.
export function outreachDecision(candidate) {
  const decision = qualificationDecision(candidate);
  return Object.freeze({
    canDraft: decision.stage === QUALIFICATION_STAGES.DRAFT_READY,
    canSend: false,
    blockers: decision.blockers,
    stage: decision.stage,
  });
}
