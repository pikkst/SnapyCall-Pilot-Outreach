# Bring your own AI: provider credential contract

## MVP: one administrator, one active provider

The current UI supports Gemini and OpenAI. The administrator chooses an
explicit model ID and pastes a provider API key into an authenticated Settings
form. The server stores an AES-256-GCM envelope in `AiSetting`, with the
encryption key supplied **only via** `AI_ENCRYPTION_KEY`.

- GET `/api/ai-settings` returns provider, model, keyConfigured and a
  non-secret SHA-256 fingerprint prefix. **Never** returns the API key.
- PUT `/api/ai-settings` changes model or provider; switching providers
  requires a new key. An empty key retains the existing key for the
  current provider.
- DELETE `/api/ai-settings` deletes the stored key; generation is disabled.
- POST `/api/candidates/:id/draft` makes a provider call **on the server**,
  stores the generated draft and audit event. This is a billable provider call.
- There is no email send endpoint. Draft approval and sending are separate
  future milestones.

## Security / operational constraints

- Use HTTPS with a trusted reverse proxy; cookies are HTTP-only, Secure in
  production and SameSite=Strict. All mutations validate Origin.
- `ADMIN_EMAIL` and `ADMIN_PASSWORD_HASH` are provisioned via deployment
  secrets; no public registration or implicit first-user admin.
- `SESSION_SIGNING_KEY` must be at least 32 characters and
  `AI_ENCRYPTION_KEY` must contain exactly 32 random bytes encoded as hex.
  Keep encryption key stable across restarts. If lost, existing provider
  credentials are unrecoverable and must be replaced.
- Only supported, hard-coded AI provider hosts may receive credentials.
  Model IDs are strictly validated. Arbitrary OpenAI-compatible base URLs are
  **not** in scope.
- API responses and application logs must not include provider credentials.
- Network timeout on provider calls: 20 seconds; per-IP draft generation
  limited to 6/minute. For shared multi-instance deployments, replace
  in-memory rate limiting with a distributed limiter.
- Provider model IDs and API availability can change; the UI does not claim
  any selected model will work until a generation attempt succeeds.
- Future multi-user support must migrate `ownerId` to authenticated
  database-backed identities and enforce record-level ownership.
- Rotating the encryption key requires decrypt/re-encrypt of stored
  credentials; simply replacing the environment secret will break reads.

## Migration and deployment

Project: `shiny-forest-27088168` (separate from LeadScout).
Database: `snapycall_pilot`, region `aws-eu-central-1` (Frankfurt).
The initial Prisma migration is tracked in the repository. Do **not**
apply it automatically to production on PR merge; verify clean-start in CI,
then run the existing migration on a separate development branch before
explicitly authorized production deployment.
Do not run a demo seed or load live third-party contact data without review.
