# Local development — SnapyCall Pilot Outreach

This guide reflects the existing Node 22 / Express / Prisma / React architecture.
It is a setup reference, **not** permission to run paid AI searches or write to
the shared Neon pilot-staging or production database.

## Prerequisites

- Node.js 22+ with npm, Git, and a **separate local or disposable PostgreSQL 17** database.
- Windows 11 + PowerShell 7 works; the commands below use PowerShell syntax.
- Never use the production or shared `pilot-staging` Neon connection string for local migrations, smoke, tests, reset or fixture writes.
- Local machine secrets must remain outside Git: `.env` is ignored by `.gitignore`.

## Clone and validate

```powershell
git clone https://github.com/pikkst/SnapyCall-Pilot-Outreach.git
cd SnapyCall-Pilot-Outreach
node --version
npm ci
Copy-Item .env.example .env
```

Fill `.env` with **separate development** database credentials, `ADMIN_EMAIL`,
a one-time `ADMIN_PASSWORD` (12–72 UTF-8 bytes), and random signing/encryption
keys. Generate keys on your own computer:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Run this twice and put **different** output values in `SESSION_SIGNING_KEY`
and `AI_ENCRYPTION_KEY`. Do not paste them into chat, CI logs, a PR or Git.

Set `DATABASE_URL` and `DIRECT_URL` to your isolated development database;
a direct `DIRECT_URL` is required for Prisma migrations. If the database has
not yet been initialized, applying **tracked** migrations is supported:

```powershell
npm run db:validate
npm run db:deploy
npm run typecheck
npm run check
npm test
npm run build
npm run dev
```

`npm run db:deploy` writes schema migrations to its target database. Review
both URLs and confirm the target is disposable/development **before running it**.
Do not invoke destructive Prisma reset/seed commands on shared databases.

Open `http://localhost:3000` for the local same-origin UI and API.
`npm run dev` starts the Express server with watch mode; it does **not**
start a separate Vite HMR server. Build the UI with `npm run build` first
when frontend changes need to be served.

## Optional Google OAuth (development client)

Partner login / Google Forms+Sheets consent are optional; leave
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and redirect URIs empty
until needed. The runtime requires **HTTPS callback URIs**; localhost HTTP
callback will fail validation. Configure a separate HTTPS development
origin (local reverse proxy or trusted development tunnel), register its
exact origin and callback URLs with the Google OAuth client, and set:

- `GOOGLE_REDIRECT_URI=https://<dev-host>/api/auth/google/callback`
- `GOOGLE_DATA_REDIRECT_URI=https://<dev-host>/api/partner/google/connect/callback`
- `GOOGLE_GMAIL_REDIRECT_URI=https://<dev-host>/api/partner/google/gmail/callback` only if needed.

Do not reuse production callbacks for local test accounts. Google data consent
remains read-only; optional Gmail consent alone does not enable campaign sending.

## Optional Resend / AI providers

Leave `RESEND_API_KEY` and `PARTNER_INVITE_FROM` empty to avoid sending
partner invitations during local development. Candidate outreach must remain off.

AI provider BYOK keys are entered through authenticated application Settings
and stored encrypted in the development database, **not** in `.env.example`.
The Tavily server-side credential is optional and must remain absent unless
a controlled, separately authorized paid test is planned.

Every `AI_..._ENABLED` feature flag is OFF by default in the example.
Flipping a flag is **not sufficient** authority to run paid searches:
existing price-version, owner budget, source rights, approval and usage caps
must also be independently satisfied. RD-01/RD-02 work should use offline
and synthetic fixtures first.

## Startup and security checklist

1. Confirm `git status --short` does **not** list `.env`.
2. Confirm DB URLs target your dedicated development database and not any
   Render/production/pilot-staging service.
3. Keep `NODE_ENV=development` for direct local HTTP; production cookies
   require HTTPS.
4. Admin bootstrap consumes `ADMIN_PASSWORD` once for a new database;
   remove that value from `.env` after initial successful bootstrap.
5. Keep persistent `SESSION_SIGNING_KEY` and `AI_ENCRYPTION_KEY` across
   routine restarts; changing encryption keys breaks stored BYOK tokens.
6. Treat green CI as validation only; never interpret it as an authorized
   deploy or permission to send mail.

## Next engineering work

Start with approved **RD-01** evidence funnel baseline and **RD-02** offline
HTML evidence coverage. See
[AI98_DISCOVERY_BENCHMARK_PLAN.md](AI98_DISCOVERY_BENCHMARK_PLAN.md) and
[AI98_CONTACT_DISCOVERY_ROOT_CAUSE_AUDIT.md](AI98_CONTACT_DISCOVERY_ROOT_CAUSE_AUDIT.md).
Production paid benchmark RD-05, provider changes, live rollout, merge and
deployment require separate CTO approval.
