# SnapyCall Pilot Outreach

Independent **pilot-expert acquisition** application for SnapyCall, operated separately from SnapyCall's production notification systems. Its goal is to discover, qualify and review potential experts and draft factual outreach, with deliberate approval gates before any sending.

## Current implementation (November 2026)

| Area | Implemented | Not yet activated / remaining |
| --- | --- | --- |
| Hosting | React 19 + Vite 6 frontend; Node 22 / Express 5 server; Render staging at [pilot.eventnexus.eu](https://pilot.eventnexus.eu/) | Public multi-tenant production rollout |
| Database | Neon PostgreSQL, Prisma 6 migrations; workspace-scoped Candidate uniqueness with partial indexes for legacy admin records; provenance and audit events | Fully scoped partner mutation workflow, Google response ingestion |
| Authentication | Separate legacy admin credentials and invited Google OAuth partner login; signed cookies, session boundaries, per-workspace membership checks | Automatic role convergence or Google-based administrator privilege (intentionally unsupported) |
| Workspace UX | Admin dashboard, partner dashboard with the same app-shell/navigation; partner workspace selector and read-only candidates/drafts | Partner edit, evidence/review, draft generation and import endpoints require separate server-side tenancy work |
| Membership | Legacy administrator can provision partner workspaces and send/resend invitations through protected admin endpoints | Member revocation/removal UI and endpoint are **not implemented yet**; partners cannot manage members |
| Google data | Per-user/per-workspace Forms and Sheets read-only OAuth consent with encrypted refresh tokens | Source selection, field mapping, sync/import, and automatic scheduled refresh: not implemented |
| AI drafting | Gemini, OpenAI and Claude (Anthropic) BYOK; server-side encrypted per-user API keys | Partner draft workflow, automated outbound sending |
| AI discovery | Free manual search, admin-approved RSS/Atom discovery; bounded citation-backed Claude web research preview | `AI_WEB_RESEARCH_ENABLED` is disabled by default and requires budgets/approval before use |
| Gmail | Optional separate `gmail.send` consent foundation | Authorization may be disabled in staging; **no Gmail send endpoint or campaign sending enabled** |
| Outbound messages | Admin partner-invitation delivery through the separately configured Resend provider | Candidate outreach sending, campaigns, bounce/complaint workflows and automation not enabled |

The dashboard layout does **not** grant permissions. Admin and partner sessions remain separate; all candidate, draft and membership access must be enforced on the server. Current partner read access is restricted to the selected authorized workspace. Legacy admin Candidate records retain `workspaceId = NULL`.

## Run locally

Requirements: Node.js 22+, npm and PostgreSQL/Neon credentials for persistent workflows.

```bash
npm ci
npm run db:validate
npm run typecheck
npm run check
npm test
npm run build
```

For local server startup copy the **names** from `.env.example` into a local `.env`, supply your own credentials, then:

```bash
npm run db:deploy
npm run dev
```

Do not put real credentials or Google refresh tokens in the repository. The Render service runs `npm run db:deploy && npm start` and has automatic deploy disabled: merging does **not** deploy. Database migrations require upgrade + clean-start test evidence before an authorized staging deployment. Do not run migrations blindly against an unknown database.

## Integration / release rules

- The Google OAuth application callback, Forms/Sheets consent callback and separate Gmail consent callback must match the registered canonical domain `pilot.eventnexus.eu`.
- Forms/Sheets OAuth grants `forms.responses.readonly` and `spreadsheets.readonly` only; it **does not** imply Drive listing privileges, automatic syncing, contact consent, or right to email respondents.
- Outreach remains draft-only. Never use `gary.ljamin@snapycall.com` or SnapyCall's production notification infrastructure. `gary@snapycall.com` is not an authorized `From` identity.
- Public profiles and RSS authors are unverified research leads, not permission to scrape or automatically contact them.
- CI uses mocked provider interactions and disposable databases; never send live outreach, use real paid AI search, run uncontrolled migrations or seed real candidate data in CI.
- Google partner sessions must not access legacy admin-only invitations, membership management or NULL-owned records. Tenant-specific writes must recheck membership transactionally and remain idempotent.
- Rotate neither `AI_ENCRYPTION_KEY` nor `SESSION_SIGNING_KEY` casually; rotation requires a migration/session invalidation plan.

## Documentation

- [Architecture and rollout gates](docs/architecture.md) (original MVP decisions; historical background)
- [Workspace-scoped Google source/sync contract](docs/google-source-sync-contract.md) — design, sync **not enabled**
- [Workspace-scoped candidate identity](docs/tenant-candidate-identity.md)
- [Claude web research preview](docs/ai-web-research-preview.md)
- [Free discovery](docs/free-discovery.md)

## Roadmap / tracked work

- [#28 Google Forms/Sheets source preview, mapping and review-gated ingestion](https://github.com/pikkst/SnapyCall-Pilot-Outreach/issues/28)
- [#29 Dependency vulnerability triage](https://github.com/pikkst/SnapyCall-Pilot-Outreach/issues/29)
- [#31 Partner/admin dashboard parity and member-management permissions](https://github.com/pikkst/SnapyCall-Pilot-Outreach/issues/31)

*This README describes implemented behavior separately from planned work. Do not treat an authorized connector, a merged foundation, or a green CI as proof that an optional external integration is activated.*
