import { z } from "zod";

// A partner's self-editable sender identity is intentionally independent
// from OAuth email, workspace roles, contacts and campaign authorization.
const optionalLine = max => z.string().trim().max(max).transform(value => value || null);
const phone = z.string().trim().max(32).regex(/^[+0-9(). \-]*$/, "Use a work phone number").transform(value => value || null);
const website = z.string().trim().max(2048).refine(value => {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      !url.port && url.hostname.includes(".") && !/\s/.test(value);
  } catch { return false; }
}, "Use a public HTTPS website").transform(value => value || null);
const signature = z.string().trim().max(1000).refine(value =>
  !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value),
"Invalid signature characters").transform(value => value || null);

export const partnerSelfProfileInput = z.object({
  displayName: optionalLine(120),
  jobTitle: optionalLine(120),
  organizationName: optionalLine(160),
  businessPhone: phone,
  publicWebsite: website,
  emailSignature: signature,
}).strict();

export function publicPartnerSelfProfile(user) {
  return {
    displayName: user.displayName ?? "",
    email: user.emailNormalized, // Google-linked identity, always read-only.
    jobTitle: user.jobTitle ?? "",
    organizationName: user.organizationName ?? "",
    businessPhone: user.businessPhone ?? "",
    publicWebsite: user.publicWebsite ?? "",
    emailSignature: user.emailSignature ?? "",
  };
}
