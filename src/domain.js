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

export function scoreCandidate(candidate) {
  const c = normalizeCandidate(candidate);
  if (!c.onlineEnglish) return Object.freeze({ eligible: false, score: 0, reasons: ["english_online_requirement_unconfirmed"] });
  if (candidate.discoveryKey && !c.profileReviewed) return Object.freeze({ eligible: false, score: 0, reasons: ["expert_profile_review_pending"] });
  const regionScore = c.region ? REGION_PRIORITIES[c.region] : 0;
  return Object.freeze({
    eligible: true,
    score: EXPERT_CATEGORIES[c.category] + regionScore,
    reasons: c.region ? [] : ["region_unconfirmed"],
  });
}

// Draft eligibility is distinct from send permission.
export function outreachDecision(candidate) {
  const c = normalizeCandidate(candidate);
  const errors = [];
  if (!c.onlineEnglish) errors.push("english_online_requirement_unconfirmed");
  if (candidate.discoveryKey && !c.profileReviewed) errors.push("expert_profile_review_pending");
  if (!c.email) errors.push("email_missing");
  if (!c.legalBasis) errors.push("legal_basis_missing");
  if (!c.contactReviewed) errors.push("contact_review_pending");
  if (c.suppressed) errors.push("suppressed");
  return Object.freeze({ canDraft: c.onlineEnglish && (!candidate.discoveryKey || c.profileReviewed) && !c.suppressed, canSend: false, blockers: errors });
}
