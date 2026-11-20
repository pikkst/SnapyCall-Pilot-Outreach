# SnapyCall internal expert outreach — architecture and operating playbook
Status: proposed, 2026-11-16. No campaign sending authorized by this document.

## 1. Product goals and boundaries
An internal workplace for multiple SnapyCall staff to search for experts, triage sourced candidate leads, prepare permission-aware invitations, and measure campaign outcomes. Goal: *100+ discovery candidates per research campaign* where sufficient lawful public evidence exists, not 100 automatically verified/sendable emails. Users must not inspect each profile just to queue candidates.
Current baseline: workspace-owned Candidate in Neon Postgres, CandidateEvidence, audited workspace-scoped intake, Gemini/OpenAI/Claude BYOK web search, <=20 candidates per call, no outbound campaign send API. Google Forms/Sheets auth exists read-only; actual Sheets sync is not implemented.

## 2. Separate identities and failure domains
- **Sign-in identity:** each operator's invited Google login, scoped by active workspace membership.
- **Data authority:** Neon PostgreSQL is canonical for candidates, evidence, research jobs, approvals, campaigns and events. A company-admin-owned Google Sheets/Forms connection provides optional read-only ingestion and an export/sync projection. Losing Sheets access must not destroy primary records; losing a sender must not affect the Sheet.
- **Sending identity:** separate explicit verified sending domain/service and sender records, never implicitly inherited from Google sign-in or Google Sheets OAuth. Revoking or disabling one sender pauses that sender's jobs without making the underlying data unavailable.
- Keep Google OAuth credentials, Sheets tokens, and Resend/API sending credentials isolated, encrypted with narrowly scoped access and audited rotation/revocation. Do not reuse personal Google mailbox for application identity plus shared campaign sending.

## 3. Target workflow
1. Admin creates an internal workspace, assigns roles, attaches approved read-only Form/Sheet sources and, separately, a verified sending identity.
2. Operator defines search criteria, jurisdictions, expertise and target candidate count; system estimates API cost and enforces owner/workspace quota.
3. Bounded asynchronous research job divides criteria into multiple narrow searches and source groups; each batch has a stable idempotency key, quota reservation, retry policy, provenance and provider-authoritative citation metadata. Never treat AI-written URLs or emails as fact.
4. Source inspection, where authorized and technically safe, extracts publicly listed professional information from declared sources; no authentication bypass, prohibited scraping, invented addresses or guessing patterns. Store original public URL, timestamp, extraction mechanism, observation and relationship-to-person confidence separately.
5. Canonical Candidate and CandidateEvidence are reused. Deduplicate by deterministic evidence-linked identity (exact trusted profile, public email where justified, provider+citation identity) and flag namesakes; never merge solely on a shared company contact page. An organization-level inbox must NOT be assigned to every named individual.
6. UI shows total discovered / duplicates / linked public sources / contact observations / needs manual review / review-ready. Operators bulk-select and queue candidates without confirming every link.
7. Contact eligibility is a separate checkpoint: source verified, recipient identity/context reviewed, suppression/opt-out screened, applicable legal basis established, and email channel permitted. Candidate creation alone confers no sending permission.
8. Approved campaign captures campaign version, selected recipients, sender domain, questionnaire URL, template variant, audit actor/time and immutable dispatch snapshot. Sending is disabled until expressly released.
9. Provider callbacks and form responses update delivery, bounce, complaints, unsubscribe, response and questionnaire/participation metrics with idempotent event storage.

## 4. 100+ retrieval contract
- Use a bounded multi-page research *job*, not a single LLM response of 100 people.
- Each page is limited to 20 candidates (current API bound), with bounded total pages/cost and deterministic checkpointing; 100 unique candidates may require considerably more than five pages.
- Stop at source exhaustion, budget, rate limit, safety/terms block or maximum attempts. Report actual unique grounded counts. Do not fill gaps with invented contacts.
- Budget first: user-visible ceiling, spend reservation and cost reconciliation. Rate limit, exponential retry with jitter for transient errors, lease/heartbeat, resume, cancellation and per-workspace concurrency.
- Citation quality buckets: durable inspected public profile; public organization page only; provider grounding redirect only; missing/unavailable. Each record has a resolution path and must distinguish research evidence from contact permission.
- Accuracy quality gates: sampled precision, provenance URL validity, uniqueness, person/organization ambiguity and raw-to-canonical traceability. Count discovered candidates separately from contactable leads.
- Security: provider responses untrusted, URLs validated before any fetch, no internal/private SSRF redirects, no PII/token logs, explicit allowed-site policy and retention controls.

## 5. Proposed operator UI
Top navigation: Dashboard / Research / Candidates / Outreach / Analytics / Admin Center (admin only).
Dashboard: Start research, research jobs in progress, candidate totals by evidence level, pending reviews, drafts pending approval, sender health, last Sheets sync, spend.
Research: one criteria form + desired count (e.g. 100), budget estimate and progress; results grid with source evidence and bulk review-queue action.
Candidates: table with name, category, organization, email observation (if any), source URL or unresolved label, evidence status, next action, dedupe warning; select-all/batch actions; per-row edit for exceptions only.
Outreach: choose reviewed recipients, independently verified sender, questionnaire, five approved content variants, preview and explicit human send approval; suppression and quota gates.
Analytics: attempted, delivered, bounced, complaints, unsubscribed, replied, questionnaire completed, accepted / joined. Distinguish event evidence and attribution; never claim opens as certain human reads.
Admin Center: team roles, Google Sheets/Forms source registration and sync mapping, sender connections, template approvals, budgets, audit, suppression rules and integration health.
Mobile: accessible bulk selection, sticky batch action, error states, keyboard/touch targets and honest disabled-feature labels.

## 6. Google Sheets/Forms integration
Existing per-user/per-workspace consent is read-only. Do not simply transfer someone's refresh token into an admin account; define an explicit admin-authorized integration owner with exact source ID and a safe connection lifecycle. Permission-loss, account suspension and stale token show a reconnect status but retain all canonical records in Neon. Scope sync to approved Sheets/Forms IDs, never arbitrary Drive scan by default. Immutable source ID + row/response mapping + cursor/idempotency + audit are required. Avoid write-back unless separately approved. Access to source data remains controlled by Google sharing permissions; using a separate sender account does not itself make Sheets indestructible.

## 7. Email templates — draft variants for editorial A/B testing
These five transparent, professional variations share a single purpose. Variation assignment must be recorded deterministically per campaign/recipient for reproducibility; **not** used to disguise automated bulk messages or bypass spam filtering. No sending without reviewed eligibility, identification of sender, permitted contact basis and a valid opt-out path.

Common fields: {first_name}, {expertise}, {sender_name}, {sender_role}, {company_name}, {questionnaire_url}, {opt_out_instruction}. Tokens must be validated, not fabricated. Only reference expertise supported by evidence. No misleading affiliation or pressure tactics.

### A — Direct invitation
Subject: Invitation to share your expertise with SnapyCall
Hi {first_name},
I'm {sender_name} from {company_name}. We're inviting professionals working in {expertise} to tell us about their experience and interest in future expert opportunities.
If this is relevant, here's a short questionnaire: {questionnaire_url}
Thanks for considering it.
{sender_name}, {sender_role}
{opt_out_instruction}

### B — Context first
Subject: A quick question about your professional expertise
Hi {first_name},
I'm reaching out on behalf of {company_name} because your publicly described work in {expertise} appears relevant to the expert community we're building.
Would you be open to sharing a little about your background? You can do so here: {questionnaire_url}
Best,
{sender_name}
{opt_out_instruction}

### C — Participation-focused
Subject: Would you be interested in expert opportunities?
Hello {first_name},
At {company_name}, we're learning more about professionals with experience in {expertise}. I'd like to invite you to a short questionnaire to see whether future collaboration could be of interest.
Questionnaire: {questionnaire_url}
Kind regards,
{sender_name}
{opt_out_instruction}

### D — Concise
Subject: SnapyCall expert invitation
Hi {first_name},
I'm {sender_name} at {company_name}. We would welcome your perspective on {expertise}.
If interested, please complete our short questionnaire: {questionnaire_url}
Thank you,
{sender_name}
{opt_out_instruction}

### E — Open-ended
Subject: Exploring a possible expert connection
Hi {first_name},
I work with {company_name} and came across your publicly available professional work relating to {expertise}.
We're inviting relevant specialists to introduce themselves for possible future opportunities. If you'd like to explore this, here's our short form: {questionnaire_url}
All the best,
{sender_name}
{opt_out_instruction}

## 8. Release gates
- Contract, migration upgrade/clean-start and workspace isolation tests; no owner/tenant privilege crossover.
- No cross-identity coupling: disabling a sender does not revoke Sheets/Forms or delete Candidate records; disabling Sheets does not disable login or existing approved internal data.
- 100+ jobs: tests for >100 unique grounded candidates across batches, duplicates, zero-result, partial errors, quota exhaustion, retries, cancellation, rate limits, provider 401/429 and interrupted restart.
- Manual mobile and desktop smoke with actual approved sources and operator role, with costs capped.
- Sending feature separately approved; dry-run and provider sandbox tests; authenticated sender verification, opt-out/suppression, idempotent event attribution, no duplicate delivery.
- Only release features whose CI and staging evidence are verified. No automatic sending in current pilot.

## 9. Agentic research campaign — implementation decision (2026-11-16)
The worldwide 100+ candidate goal uses a **durable task orchestrator**, not a giant prompt or open-ended autonomous browsing. Tracking issue: #62.

Agent stages: (1) deterministic planner partitions by specialty/region/approved source, (2) bounded discovery workers invoke the existing provider-neutral search adapter, (3) authorized evidence resolver produces durable public URLs or explicit unresolved provenance, (4) contact enrichment distinguishes organization inboxes from person-associated addresses, (5) workspace-scoped identity/dedupe resolves collisions without name-only merges, (6) quality gate retains pending evidence and non-sendable state, (7) reporter exposes live progress, cost, and cited sources.

The orchestrator persists job/task/attempt/cursor/lease/heartbeat/status and payment reservation in Neon. All tasks must be retry-safe and cancelable; budget and workspace authorization rechecked before every paid call and write. Bound work by provider calls, time, tokens, overall USD cost, source policies and concurrency. A 100-candidate search may require more than five 20-result calls; return partial trustworthy results with exhaustion reasons rather than fabricate candidates.

Success metrics are strictly separated: sourced candidate count, inspected profile count, observed professional contact count, person-associated contact count, outreach-eligible count, and actual replies. A 100+ goal applies to **sourced discovery candidates**; never claim 100+ verified professional emails until separately evidenced.
