import { verifySession } from "./security.js";
import { verifyPartnerSession } from "./google-auth.js";

// Two independently signed cookies are never an implicit role switch.
// Fail closed even if the frontend still displays an old administrator view.
export function sessionIdentityState(cookies, signingKey) {
  const admin = verifySession(cookies?.pilot_session, signingKey);
  const partner = Boolean(verifyPartnerSession(cookies?.pilot_partner_session, signingKey));
  return { admin, partner, conflict: admin && partner };
}

export function canUseAdminSession(cookies, signingKey) {
  const identity = sessionIdentityState(cookies, signingKey);
  return identity.admin && !identity.conflict;
}
