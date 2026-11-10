# Architecture decision record: Pilot Outreach MVP

## Bounded context
This repository is a **pilot acquisition tool**, not a fork of LeadScout
and not a SnapyCall production service. No dependency on SnapyCall's
notification system, customer accounts, or existing SMTP keys.

## Confirmed business requirements
- Recruitment goal: first 20 pilot experts.
- Categories: AI/no-code (30%), coaching (30%), marketing/growth (20%),
  business strategy/development (20%).
- Region preference: US (40%), UK/Ireland (40%), other English-speaking markets
  (20%); candidates must consult online in English.
- Pilot application: https://forms.gle/5xGr5SbFAknhomTb6
- Gary rejected `gary.ljamin@snapycall.com` as a sending identity and declined
  using SnapyCall's production notification infrastructure.
- Long-term bulk automation is conditional on knowing and approving what is sent.

## Decisions
- Private, independent repo; separate Neon database, not LeadScout's DB.
- Future stack: React + Vite, Express, Prisma, PostgreSQL; same-origin HTTP.
- First milestone is **pure domain functions with deterministic tests** and
  **no credentials, no sending and no database writes**.
- External directory links (Udemy, LinkedIn, Clarity etc.) are **research
  candidates**, not permissions to scrape, republish contact data or send mail.
- Do not import the spreadsheet until its provenance, fields and personal-data
  processing purpose have been verified.

## Planned persistent contracts
- `Candidate`: id, type (expert/partner), category, country/region, language,
  source URL, collection timestamp, evidence, confidence, review status.
- `ContactMethod`: candidate, normalized address, provenance, review status,
  legal basis, suppression status; unique scoped identifier for deduplication.
- `Campaign`: audience criteria, draft template version, owner, approval,
  sending state (disabled by default), daily limit.
- `OutreachAttempt`: immutable campaign/contact/template snapshot,
  idempotency key, provider ID, send status, retry policy, timestamp.
- `Suppression`: normalized address/domain, reason, first-seen timestamp;
  checked transactionally before sending.
- `ApplicationOutcome`: external form application reference (only if lawful
  and available), linked candidate, state, evidence.
- `AuditEvent`: who approved, imported, edited, sent, suppressed or exported;
  retention and access policies.

## Rollout gates
1. Pin dependency versions and build deterministic CI.
2. Implement authentication with pre-provisioned admin identity, not
   publicly accessible first-user registration.
3. Add Prisma migrations and verify clean-start plus upgrade path on an
   isolated Neon branch; keep all database credentials server-side.
4. Import reviewed source records; preserve idempotency, duplicates and evidence.
5. Draft review and one-candidate dry-run.
6. Configure independent sender identity, SPF/DKIM/DMARC, bounce/complaint
   feedback, opt-out, daily limits and retry safety before any real send.
7. Explicit approval before outreach to live contacts or public rollout.

## Non-goals for MVP
Automated social scraping, LinkedIn automation, agent framework, marketplace
features, integrations with SnapyCall's production email systems, or automatic
sending based only on publicly visible contact details.
