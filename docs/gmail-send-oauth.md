# Optional Gmail send authorization foundation (disabled by default)

This pilot must never use SnapyCall's domain as an outbound sender. Each
invited Google user may separately authorize their own Gmail account to send
*their reviewed emails* from that account. Normal Google identity login does
not grant Gmail send permissions. The existing Forms/Sheets read grant remains
separate.

## Current scope (not a sending feature)

- `GMAIL_OAUTH_ENABLED` defaults to false. It must equal `true` and
  `GOOGLE_GMAIL_REDIRECT_URI` must be configured on the server.
- Google Cloud must allow the exact redirect
  `https://<staging-domain>/api/partner/google/gmail/callback`.
- Request exactly `openid`, `email`, and `gmail.send` using the existing
  signed+expiring browser-bound PKCE OAuth helper.
- Verify the returned ID token, nonce, verified email and immutable subject
  match the user's invited identity; check active membership before the
  callback and again transactionally before persistence.
- Encrypt a separate refresh token under `PartnerGmailConnection.userId`.
  The Forms/Sheets token stays untouched. Never expose raw/encrypted tokens
  through API responses.
- The status endpoint advertises `sendingEnabled: false` in all states.
  No Gmail API mail send call or send endpoint exists in this PR.
- Disconnect removes only the local grant, not Google's remote authorization.
  Users may revoke access in Google Account settings.

## Mandatory gates before sending any real message

1. CTO review of tenant-aware workspace and per-user BYOK access.
2. Google Cloud verification for sensitive `gmail.send` scope and approved
   verified-domain privacy/terms disclosures; staging test users only until then.
3. Verified provider identity and user-controlled sender address.
4. Reviewed approved recipients/candidate records, evidence and legal basis,
   suppression/opt-out and recipient eligibility enforcement.
5. Explicit batch approval, bounded sending rate, audit and transactional
   concurrency/idempotency contract. Gmail API may not deduplicate by
   idempotency key: never silently resend after an ambiguous success.
6. Per-user and per-workspace limits, retry-safe monitoring and cancellation,
   failure-state accounting and manual reconciliation for uncertain delivery.
7. Dedicated disposable mock tests and approved staging live-account smoke.

No production deployment, Google scope activation or Gmail sending is authorized
by adding this foundation.
