# Google Forms and Sheets — workspace-scoped intake contract (issue #28)

Status: **design-only / no sync activated**. The Google consent shown in the partner UI only establishes read access; it does **not** imply that candidate data is synchronized, contact is authorized, or Gmail sending is enabled.

## Existing integration points (reuse, do not fork)
- Google identity: signed partner session via `/api/partner/session` and `partnerIdentity` in `server/index.js`.
- Membership: `PartnerMembership`, `requireWorkspaceMembership`, `lockActiveWorkspaceMembership` in `server/workspace-access.js`.
- Consent: `PartnerGoogleConnection` uniquely scoped to `(partnerId,userId)` with encrypted refresh token. Connection API `/api/partner/google/connections`, consent start/callback, disconnect; `server/google-data-auth.js`.
- Cryptography: `encryptKey`/`decryptKey` and the existing `AI_ENCRYPTION_KEY`; do not introduce a separate key store, return refresh tokens to a client, or rotate the key without a migration plan.
- Candidate identity: `Candidate.workspaceId` and workspace-scoped uniqueness, legacy admin records have `NULL` workspace. Candidate write contract at existing `POST /api/candidates`. No direct imported candidate creation without evidence/legal review.
- Audit: existing `AuditEvent`; do not claim a sync succeeded before provider fetch and durable write succeed.

## Permissions and source selection
Current consent uses only `forms.responses.readonly` and `spreadsheets.readonly`. It does **not** grant Drive-wide file discovery. Initial UX takes an explicit Form ID / Spreadsheet ID or a user-supplied Google URL, parses IDs strictly, and records a source under the selected workspace. Don't add `drive.readonly` or `drive.metadata.readonly` implicitly.

A source is not eligible for sync merely because an account granted read-only permissions. The user must select its workspace and approve the exact source and field mapping. Access control must use verified session + exact live membership + the same user's workspace-specific stored connection; never accept userId, Google subject, workspace owner, or refresh token in the request payload.

### Staged delivery
1. **R1 — authenticated read-only preview**: source validation, Google access-token refresh server-side, bounded fixed Google API origin, strict timeout and response-size/page limits. Return field names and a minimal redacted sample only. Never persist fetched personal responses or emit them in logs.
2. **R2 — mapping preview**: explicit mapping of `name`, `email`, `field/category`, questionnaire answers, and provider source/response identifier; show invalid/missing fields. No automatic inference of consent or legal basis from an email address.
3. **R3 — reviewed ingestion**: idempotent source + response identity per workspace, non-destructive immutable evidence provenance, staged review queue, membership lock or safe equivalent through commit, retries/replay protection and source cursors. Operator approval is required before creating outreach-eligible candidates.
4. **R4 — user-controlled sync cadence**: manual sync first; scheduled sync only after R1–R3, budgets/quotas, observability, revocation and retention contracts pass smoke.

## Minimal data contract (future implementation)

```ts
type GoogleIntakeSource = {
  workspaceId: string;       // From verified membership, never trusted from payload alone
  provider: "google";
  type: "form" | "sheet";
  sourceId: string;          // Strict, bounded provider identifier
  ownerUserId: string;       // From the existing authenticated connection
  mappingVersion: string;
  enabled: boolean;         // false by default
};

type GoogleIntakeEvidence = {
  workspaceId: string;
  sourceId: string;
  externalResponseId: string; // Stable ID for dedup where Google supports it
  sourceType: "form" | "sheet";
  sourceRevision: string | null;
  collectedAt: string;
  // Data subject and raw response retention require separate explicit policy.
};
```

For Sheets, row numbers alone are **not stable response identifiers** after sorting/insertion. Require a reviewed stable response key column or persist a snapshot/fingerprint strategy that cannot silently rebind a changed row. Do not build an idempotency key from spreadsheet row position alone.

## Risk and failure matrix
- **Expired/revoked OAuth grant / missing scopes** → actionable reconnect state; never fallback to another user's token.
- **Member revoked while provider call in-flight** → recheck and serialize membership authorization with the durable commit; do not save rows in the wrong workspace.
- **HTTP 429 / 5xx / timeouts** → bounded backoff, no duplicate import or cursor advancement before commit; expose retryable status.
- **HTTP 403/404 source access** → source-level disconnected/unavailable, not empty data and not "sync completed".
- **Two workspaces using one Google account/source** → independent source binding, storage, review and dedup; no automatic cross-tenant merging.
- **Partial Forms pagination / Sheets range or header changes** → explicit schema version and partial-result warning; never silently mark a complete sync.
- **PII / consent / email address** → read-only grant is not outreach permission; data minimization, retention, deletion, legal basis and suppression remain independent approvals.
- **Google permission changes** → no additional OAuth scopes without explicit product/user consent.
- **Gmail sending** → separate authorization and disabled rollout; never activated by data import.

## Acceptance gates before rollout
- R1: mocked Google Forms/Sheets response, HTTP error, token refresh, pagination and ID validation tests.
- R1/R2: verified partner membership, CSRF/Origin protection, cross-workspace and cross-user denial, disconnect/revocation races.
- R3: disposable PostgreSQL migration clean-start + upgrade, atomic dedup and concurrent replay tests, provenance and partial failure audit.
- CI: Node 22 `npm run check`, `npm run typecheck`, `npm test`, staging HTTP smoke and build.
- Staging: operator selects owned form/sheet, previews mapping and sees correct per-workspace results. No external mail, candidate auto-import or unapproved paid provider call.

Deployment remains separately authorized. R1–R4 are separate PRs; **this document alone enables no syncing**.
