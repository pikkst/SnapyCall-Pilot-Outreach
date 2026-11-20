# AGENTS.md — SnapyCall Pilot Outreach

These instructions apply to **every AI agent, coding assistant, reviewer, and researcher** working in this repository. Read them at the beginning of each task. A user's explicit task scope and approval boundaries take precedence over inferred work. This file is not permission to run paid research, modify shared data, merge, deploy, or send messages.

## 1. Mission and current priorities

Build a reliable, legally compliant, cost-controlled **one-user-triggered research pipeline** that discovers real relevant professionals and **independently verifiable public professional person–email evidence**, then presents qualified results for review. Optimize **qualified person–email yield per completed approved campaign**, not AI calls or raw candidate counts.

The immediate CTO-approved engineering priorities are:

- **RD-01 (P0):** reproducible, read-only evidence funnel baseline, accurate stage denominators and rejection reasons.
- **RD-02 (P0):** offline HTML/JSON-LD evidence coverage audit against labeled fixtures, measuring real verifier false negatives/positives.
- **RD-03/RD-04:** deferred until RD-01/RD-02 findings and separate CTO decision.
- **RD-05:** paid paired-source benchmark **not authorized**.

Read the source-of-truth documents before implementation:
- [Research root-cause audit](docs/AI98_CONTACT_DISCOVERY_ROOT_CAUSE_AUDIT.md)
- [Evidence-aware discovery RFC](docs/AI98_EVIDENCE_AWARE_DISCOVERY_RFC.md)
- [Research benchmark and engineering backlog](docs/AI98_DISCOVERY_BENCHMARK_PLAN.md)
- [Existing autonomous-pipeline contracts](docs/AI98_AUTONOMOUS_CONTACT_PIPELINE.md)
- [Local development setup](docs/LOCAL_DEVELOPMENT.md)
- [README and architectural baseline](README.md)

Documentation is not proof of currently deployed behavior: compare it with the **actual checked-out code, migrations, tests, and exact PR HEAD**. Report contradictions; do not silently assume the older document is authoritative.

## 2. Agent roles and handoffs

### CTO / reviewer
- Establishes scope, architectural and security constraints, acceptance criteria, dependencies and release gates.
- Reviews the actual diff, relevant historical code, tests, migrations, cost/tenant contracts, and exact-HEAD CI.
- Reports findings by severity with file/line, reproducible impact and minimal correct fix; **do not invent findings**. Explicitly state when a PR is merge-ready.
- **Review-only requests are read-only.** Do not modify code merely because you are reviewing.
- Merge, deployment, paid tests, production writes, and closure of work are **separate explicit decisions**; do not assume approval from green CI or a completed PR.

### Engineer
- Inspects repository reality and task criteria before editing; uses a narrowly scoped feature branch and PR.
- Reuses existing orchestration, endpoints, provider adapters, budget ledger, verifier, security helpers, and migrations. Avoid parallel pipelines, speculative abstractions, unrelated refactors and hardcoded shortcuts.
- Implements the **smallest production-grade fix** with deterministic positive/negative tests and migration/integration tests where applicable.
- Never modify a test merely to hide incorrect runtime behavior; settle the intended contract first.
- Handoffs include PR URL, exact HEAD SHA, changed files, tests actually run, failed/unavailable checks, evidence and residual risks.
- RD-02 is **audit first**: a proposed expansion of acceptance semantics or runtime verifier changes requires CTO review of demonstrated false negatives before implementation.

### Researcher
- Investigates actual code, documentation and **lawfully authorized** read-only, preferably anonymized aggregates.
- Separates **CONFIRMED OBSERVATION**, **CODE-CONFIRMED CONTRACT**, **INFERENCE** and **UNTESTED HYPOTHESIS**.
- Proposes reproducible evaluations, source/provider comparisons, precise denominators and spend estimates; does not claim measured yield gains without a matched-cohort experiment.
- Produces reports/RFCs and engineering proposals; research approval does **not** authorize runtime changes, collection of personal data, paid API calls or deployment.
- Handoffs give source provenance, environment (local vs staging vs production), date/commit, reproducibility limitations, and CTO decision points.

### Shared conventions
- English for code, API/DB fields, tests, commits and developer docs; Estonian is fine for owner-facing summaries.
- One task/PR per independent change where practical. Do not push to `main` directly; open a PR.
- Coordinate overlapping files and dependencies. Never overwrite another agent's working tree, revert their work, cherry-pick stale behavior blindly, or force-push a shared branch. Check `git status`, current branch and latest main before edits.
- Do not close issues, merge PRs, deploy, run billable research, enable sending, or change shared DB state without explicit approval for **that action**.

## 3. Repository and execution map

| Area | Current responsibility |
| --- | --- |
| `server/index.js` | Existing Express API and runtime feature gates |
| `server/research-full-run-stages.js` | Existing full-run orchestration |
| `server/research-person-source-plan.js` / `server/research-person-source-executor.js` | Person-source queue, query/claim, bounded source inspections |
| `server/research-provider-adapters.js` | Provider-independent/bounded retrieval and extraction |
| `server/research-public-pages.js` / `server/research-linked-contact-proof.js` | Public-page fetch, link handling and independent readback |
| `server/candidate-direct-email-evidence.js` / `server/research-structured-person-evidence.js` | Strict deterministic named-email / JSON-LD evidence |
| `server/research-observation-email.js` / `server/research-qualified-evidence.js` | Scoped email triage and qualified-evidence projection |
| `server/research-budget.js` / `server/research-quota.js` / `server/research-price-policy.js` | Owner budget, daily quotas, approved provider prices |
| `server/workspace-access.js` / `server/security.js` | Tenant authorization and security boundaries |
| `prisma/schema.prisma` / `prisma/migrations/` | Persisted DB contracts / migrations |
| `web/` | React application; `test/` | Node tests; `docs/` | Design / operational guidance |

If an exact module or contract has changed, inspect the latest repository rather than continuing from this map.

## 4. Non-negotiable production contracts

1. **Auth and tenancy:** owner/workspace membership checks on every affected read/write, including post-fetch revalidation; preserve admin-vs-partner privilege separation, revoked membership handling, transactional locks and row ownership.
2. **Budget and paid execution:** immutable approval envelope, model/price version, token/call caps, upstream hard cap, conservative reserve/settle, idempotency, task leases, atomic reconciliation, no replay of ambiguous possibly-billed work. Feature flags alone are **not** spending authorization.
3. **Source access:** HTTPS only, robots/access-policy compliance, pinned public DNS/SSRF protection, safe redirects, content/byte/time caps, per-host pacing. Never bypass authentication, CAPTCHA, robots or gated sources.
4. **Evidence:** explicit identifiable professional, relevant field, independently inspected allowed source, non-generic named professional email, exact person-to-mailbox association, URL/time/provenance and digest, conflict-safe dedup. Never infer email permutations, rely on an LLM assertion, promote shared inboxes, or infer mailbox ownership from proximity/organization alone.
5. **Acceptance and sending are separate:** `SOURCE_HINT` ≠ `QUALIFIED_EVIDENCE` ≠ `CONTACT_ACCEPTED` ≠ `SEND_ELIGIBLE`. Discovering a public email does **not** permit outreach. No automatic contact acceptance or outbound campaign sending without the existing separate approval/legal controls.
6. **Data protection and observability:** no secrets, personal emails, raw contact pages, API payloads or third-party PII in logs, audit summaries, test output, CI artifacts or PRs. Use bounded allowlisted reason-code counts; define purpose, retention and access before introducing identifiable telemetry.
7. **Backward compatibility:** preserve API and immutable job snapshots; database changes require migration review, relevant privileges/ownership checks, clean-start and upgrade-path tests. No retroactive rewriting of stopped/approved campaign history.

## 5. Local development boundaries

Canonical local setup: [docs/LOCAL_DEVELOPMENT.md](docs/LOCAL_DEVELOPMENT.md).

- Target **Node.js 22** (aligned with CI/Render), npm and PostgreSQL 17.
- On the owner's Windows machine, a dedicated Docker development PostgreSQL uses `127.0.0.1:5433`. This is **local environment context**, not a hardcoded application default or shared credential.
- Copy `.env.example` to ignored `.env`; generate distinct local signing/encryption secrets and use a **separate disposable DB**, never production or the shared Neon `pilot-staging` DB for local migrations, fixtures or resets.
- `npm run db:deploy` is a **database write**. Confirm `DATABASE_URL` and `DIRECT_URL` target an explicitly approved disposable database before running. Do not assume local DB existence merely because `.env.example` contains a sample URL.
- Keep optional provider keys and research/sending feature flags unset or disabled for offline work. No live third-party collection or paid runs without explicit approval.
- Never paste `.env`, real tokens or session/encryption keys into code review or conversation.

## 6. Verification and PR quality gates

For a scoped change, run as appropriate:

```powershell
npm ci
npm run db:validate
npm run typecheck
npm run check
npm test
npm run build
```

- Run `npm run db:deploy` **only** on a verified isolated disposable database and only if the change needs migrations or a clean-start/upgrade validation.
- Add focused Node regression tests for evidence-positive, false-positive, rejected/ambiguous, cross-tenant, revoked access, duplicated/concurrent job, retry, stale lease, unknown billing, missing telemetry and malformed input as applicable.
- Check `git diff --check`, no secrets, actual changed-file scope, documentation compatibility and status of exact-HEAD CI (including Pilot app CI / read-only smoke when required).
- Don't claim local or CI green if not run, don't claim a production smoke from mocked tests, and don't declare a PR merge-ready while required checks are pending or failing.
- Human-authenticated staging smoke, deployment, provider spending and real source collection have separate approval gates.

## 7. RD-01 / RD-02 research rules

**RD-01:** metrics must identify denominators: discovery calls, unique people, observation rows, Source jobs, cited URLs, inspected URL attempts, readable pages, qualified evidence, reviewed contacts. Preserve distinct old/new reason codes. Uninstrumented data is `unknown`, not zero. Use owner-scoped read-only data or synthetic replay; do not silently call a staging snapshot 'production'.

**RD-02:** use labeled synthetic HTML/JSON-LD/mailer contact fixtures first. Test exact person/email cards, known valid single/multi-Person JSON-LD, missing labels, namesakes, shared pages/inboxes, inconsistent mailboxes, malformed/oversized data, hidden scripts, cross-host links, changed digest and robots/HTTP failures. Report false positives and false negatives separately. Without admissible stored real HTML, synthetic coverage **cannot establish historical false-negative rates**.

**Decision:** collect findings, evaluate the smallest correct fix, and return evidence to CTO. Do not switch providers or create domain/email-first production execution before that decision.

## 8. Required handoff report

Every agent's completed task report must state:

1. **Task and scope:** what was requested, explicitly out-of-scope work.
2. **Verified baseline and sources:** branch/commit, environment and facts vs hypotheses.
3. **Changes (if authorized):** files, contract changes and migrations; or `read-only; no repository changes`.
4. **Validation:** exact commands, results, CI HEAD; limitations and blocked checks.
5. **Risk:** security, auth, tenant, cost, legal, idempotency, regressions.
6. **Next approval required:** reviewer decision, possible merge/deploy/paid test; never report unauthorized actions as completed.

This document is repository guidance. It does not override higher-priority user instructions, existing enforced code contracts, or required human approvals.
