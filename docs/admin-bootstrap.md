# One-time admin password bootstrap

This staging service has one administrator and no public registration.

## First deployment

1. Set `ADMIN_EMAIL` to the actual administrator email address.
2. In Render Environment, set `ADMIN_PASSWORD` to a strong password
   (12+ characters, maximum 72 UTF-8 bytes). Store the actual password
   securely in a password manager. Do not send it to chat or source control.
3. Merge and deploy this code after its CI passes. The tracked Prisma
   migration creates `AdminCredential` before the Express server starts.
4. The server checks whether the `admin` credential exists. If absent,
   it hashes `ADMIN_PASSWORD` with bcrypt cost 12 and writes the hash and
   a non-secret bootstrap audit event in a single database transaction.
   The plaintext is never written to the database, API responses or logs.
5. Verify the deployed service is live, then sign in using `ADMIN_EMAIL`
   and the chosen **plaintext password** (never the hash).
6. **Remove `ADMIN_PASSWORD` from Render Environment** after the first
   successful bootstrap; deploy again if Render requests a restart.

## Subsequent deploys and failure modes

- Once `AdminCredential(id="admin")` exists, it is the sole authority.
  Bootstrap never overwrites or resets the hash on subsequent starts,
  even if `ADMIN_PASSWORD` changes or remains present.
- If no credential exists and `ADMIN_PASSWORD` is absent/invalid, startup
  fails closed. The service must not expose an unauthenticated first-admin
  creation endpoint.
- `ADMIN_PASSWORD_HASH` was the previous login mechanism. It is ignored
  by this version and may be removed from Render after successful rollout.
- If the stored password is lost, setting a new `ADMIN_PASSWORD` is **not**
  a password reset. A deliberate authenticated reset/recovery procedure
  is required; no automatic reset or backdoor exists.
- `ADMIN_EMAIL` is stored on the initial bootstrap and changes to the
  environment variable no longer change that account's login email.
- Existing signed sessions remain independent of the password migration.
- Keep `SESSION_SIGNING_KEY` and `AI_ENCRYPTION_KEY` stable across deploys.
- Use the *pilot-staging* Neon branch, not production. Check that both
  direct and pooled URLs point to the same staging branch before deploying.

## Verification

CI uses a disposable PostgreSQL 17 database with clean-start migrations.
HTTP smoke validates that the database hash is bcrypt, login works, origin
checks remain enforced, provider keys do not leak, and email sending remains
unavailable. Unit tests cover restarts, missing bootstrap credentials, weak
passwords and concurrent initialization conflicts.
