# Partner Google identity foundation (PR #13)

## Security boundary

This PR introduces an **invite-only Google OIDC login** alongside the existing
admin password login. It does not grant invited partners access to the legacy
Candidate, AiSetting, drafts, discovery or admin APIs. Those routes keep the
existing `pilot_session` administrator authorization.

- The administrator can provision a Partner, PartnerUser and Membership by
  verified-email invitation through the authenticated/CSRF-protected
  `POST /api/admin/partners/invite` API or the Settings form. This action
  provisions access but **does not send an email**.
- A Google account signs in via `GET /api/auth/google/start` and
  `GET /api/auth/google/callback`. The backend uses authorization code +
  PKCE S256, short-lived signed state cookie, OIDC nonce, HTTPS token exchange,
  and RS256 ID-token signature verification against Google's public JWKS.
- Only a Google-verified email previously invited by the admin can bind its
  immutable Google subject (`sub`). Subsequent Google logins must match both
  email and subject. Uninvited identities cannot self-provision.
- Partner sessions use a separate, HTTP-only secure/SameSite cookie and a
  distinct signed purpose from the legacy admin session. Partner-specific
  session requests recheck non-revoked memberships in PostgreSQL, so
  revocations immediately deny access.
- No refresh tokens, Forms responses or personal information from connected
  Google accounts is stored in this milestone. Identity scopes only:
  `openid email profile`. A separate, explicit per-connection OAuth consent
  flow is required for Google Forms/Sheets in later work.

## Google Cloud / Render staging

Configure:
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET` (never Git, logs or browser bundles)
- `GOOGLE_REDIRECT_URI` =
  `https://snapycall-pilot-outreach-staging-bax4.onrender.com/api/auth/google/callback`

The OAuth client must be configured as *Web application* with the exact
redirect URI and an External Testing audience containing the test Google
accounts. The OAuth callback does not exist in deployed staging until a
separate authorized deploy after review. No automatic deploy.

If Google settings are absent, existing admin login remains operational;
Google login start returns 503. Existing secrets and existing AdminCredential
are not migrated or overwritten.

## Tenant migration gate (not delivered here)

Historical Candidate/AiSetting/OutreachDraft/AuditEvent records are still
administrator-scoped; assigning a default partner to them without evidence
would risk data disclosure. Consequently, **this PR deliberately exposes
no candidate, draft or AI data to partners**. Before onboarding live
partners with substantive permissions, complete a separate tenant-scoped
data migration, explicit ownership contracts, and cross-tenant negative tests.

## Verification

Unit tests: OAuth signature validation, issuer/audience/nonce/expiration,
PKCE challenge, state tampering/expiry, partner-session tampering.
Disposable PostgreSQL HTTP smoke: admin-only invite, duplicate rejection,
partner-only session, legacy API denial, immediate revocation.
Live sign-in must be verified only after approved staging deployment with
an authorized Google test account; CI uses fake credentials and never
contacts Google.
