// Verify an explicitly named personal mailbox either on a provider-cited
// profile or on one linked same-host contact document. Never promote a
// company inbox, infer an email or concatenate text across pages.
import { createHash } from "node:crypto";
import { retrieveCitedPublicPage } from "./research-public-pages.js";
import { classifyExplicitPersonEmailPage } from "./candidate-direct-email-evidence.js";
import { publicCitationUrl } from "./research-evidence.js";

export const LINKED_CONTACT_PROVENANCE =
  "AI98_EXPLICIT_NAMED_EMAIL_ON_LINKED_CONTACT";

// One additional document at most. Each document must independently prove
// the exact target name AND an explicitly labelled unique personal mailbox.
// Linking alone is not identity proof. The digest binds the link relationship,
// original provider-cited URL, linked document and its independent page proof.
export async function inspectNamedPublicContactEvidence({
  url, name, retrieve = retrieveCitedPublicPage, allowLinked = true,
}) {
  const source = publicCitationUrl(url);
  if (!source || typeof name !== "string" || typeof retrieve !== "function" ||
      typeof allowLinked !== "boolean") {
    throw new TypeError("Valid bounded named contact inspection required");
  }
  const page = await retrieve(source);
  const direct = classifyExplicitPersonEmailPage({
    name, expertProfileUrl: source, email: null,
  }, page);
  if (direct.status === "REVIEW_REQUIRED") {
    return { evidence: direct, linkedAttempted: false, linked: false,
      linkedUnavailable: false };
  }
  const linked = publicCitationUrl(page?.linkedContactUrl);
  if (!allowLinked || !linked || linked === source ||
      new URL(linked).hostname !== new URL(source).hostname ||
      new URL(linked).search ||
      !/\/(?:contact|contact-me|get-in-touch)\/?$/i.test(new URL(linked).pathname)) {
    return { evidence: null, linkedAttempted: false, linked: false,
      linkedUnavailable: false };
  }
  let contact;
  try { contact = await retrieve(linked); }
  catch {
    return { evidence: null, linkedAttempted: true, linked: false,
      linkedUnavailable: true };
  }
  const matched = classifyExplicitPersonEmailPage({
    name, expertProfileUrl: linked, email: null,
  }, contact);
  if (matched.status !== "REVIEW_REQUIRED") {
    return { evidence: null, linkedAttempted: true, linked: false,
      linkedUnavailable: false };
  }
  return {
    evidence: {
      ...matched, profileUrl: source,
      evidenceDigest: createHash("sha256").update(JSON.stringify([
        "ai98-linked-contact-evidence-v1",
        source, linked, matched.evidenceDigest,
      ])).digest("hex"),
    },
    linkedAttempted: true, linked: true, linkedUnavailable: false,
  };
}
