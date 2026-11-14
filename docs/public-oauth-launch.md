# Public OAuth pages and launch prerequisites

Public paths (served by Vite's public-directory copy, without authentication):
- `/about.html` — describe real pilot functionality (prefer this for Google OAuth homepage)
- `/privacy.html` — data, optional Google scopes, providers, rights, disconnect
- `/terms.html` — permitted use, BYOK, no live sending

**Before applying to Google for production branding/verification:** confirm the
legal controller/operator name, verifiable privacy contact, retention policy,
registered/verified domain ownership, real service operator and the exact data
processing disclosures. The text intentionally does not invent a company or
email address. The Render-owned `onrender.com` hostname may not satisfy
Google's requirement that verification be on a domain controlled by the
developer; obtain a verified custom domain if necessary. These pages alone
cannot guarantee Google approval. No OAuth publishing status was changed.

Per-user AI key contract:
- `AiSetting.ownerId` must be authenticated `PartnerUser.id` for Google users;
  legacy admin retains `ownerId='admin'`.
- Never use a workspace-global or legacy admin key as an implicit fallback.
- AES-256-GCM encrypted at rest; only metadata/fingerprint to client.
- No other user's key may be retrieved, modified, or used for drafts.
- Tenant-aware candidate access must be enabled before partner draft generation.
