# AI98 — Contact discovery benchmark and engineering backlog

**Date:** 2026-11-20  
**Status:** APPROVED RESEARCH DIRECTION; RD-01/RD-02 scope prioritized; no paid test, production run, PR merge or deploy authorized by this file.  
**Reference:** [root-cause audit](AI98_CONTACT_DISCOVERY_ROOT_CAUSE_AUDIT.md) · [architecture RFC](AI98_EVIDENCE_AWARE_DISCOVERY_RFC.md).

## Experimental questions

1. Does the current verifier miss independently valid person-email evidence already present in lawfully captured HTML?
2. Among independently available public sources, what fraction publishes valid named contact proof?
3. If accessible existing evidence is genuinely absent, does domain-first or email-evidence-first source discovery increase qualified contacts under the **same cohort and budget**?
4. Is the difference attributable to the query/search strategy, evidence parser or vendor index?

## Phase 0 — baseline data availability and governance

- Use read-only authorized **pilot-staging** aggregate diagnostics first; do not assume this is a complete production snapshot.
- Identify separately approved retention/processing basis for any real HTML fixtures. If original HTML was not retained, do not invent it or fetch it again without permission.
- No names, emails, raw page bodies, URLs or provider payloads in test logs, CI artifacts, metric aggregates or PR text.
- No access to live production secrets or paid endpoints during offline benchmark.
- Freeze reproducible cohort/fixture hashes, policy version, timestamp, model/adapter and query templates in an evaluation manifest; never rewrite previous immutable Source jobs.

## RD-01 (P0) — Evidence Funnel Baseline

**Deliverable:** reproducible read-only source/inspection/qualification funnel report and diagnostics contract.

Reuse current job outcomes and `AuditEvent.metadata.sourceInspection` rather than creating a new logging channel. Report counts with explicit units and denominator:

```text
Discovery calls
 -> distinct observed named people / observation rows (separate)
 -> planned and attempted Source jobs
 -> provider-cited hints
 -> URL inspection attempts
 -> accessible readable URLs
 -> independently attributable named-email evidence
 -> persisted qualified-evidence count
 -> review accepted contacts
 -> independently checked send-eligible records
```

Mandatory breakdowns: source-job reason, URL class (official/third-party/unknown **only when independently known**), reader error category (robots, DNS, HTTP, redirect, timeout, oversize, etc), verifier rejection reason, version/period, reserved vs settled vs uncertain cost, duration. Never infer provider invoices from internal reservations.

**Acceptance criteria:**

- All counts come from persisted evidence, reproducible query/fixture or properly sourced aggregate; no raw PII in report.
- Mixed legacy reason codes remain distinct; uninstrumented fields marked `unknown`, not `0`.
- Stage counts and URL counts are never divided by an observation count without explicit labeling.
- `qualifiedEvidence`, `CONTACT_ACCEPTED`, and `SEND_ELIGIBLE` never conflated.
- Unit tests for empty runs, overlapping stages, legacy missing metadata, duplicate observation IDs, stale timestamps, zero denominator and mixed status codes.
- Safe handling of workspace/owner scope; diagnostics not exposed cross-tenant.
- No new paid calls, DB writes or retroactive updates.

**Suggested implementation touchpoints:** existing `research-run-progress.js`, `research-qualified-evidence.js`, `research-person-source-executor.js` audit metadata, and read-only evaluation utility under current test/diagnostics conventions. Avoid extra endpoint.

## RD-02 (P0) — Offline HTML Evidence Coverage Audit

**Deliverable:** approved, labeled offline HTML fixture corpus and classification comparison of current code vs proposed minimal changes.

Use the same deterministic trusted page + verifier APIs (or suitable pure functions) from `candidate-direct-email-evidence.js`, `research-public-pages.js`, `research-linked-contact-proof.js` and `research-structured-person-evidence.js`.

Corpus should include *positive* cases with one explicitly named email, visible correct `mailto:`, one valid `Person` JSON-LD, fully explicit multi-`Person` JSON-LD and explicit person-scoped public contact card. *Negative* cases: shared mailbox, missing/ambiguous name, person mentioned on another card, namesakes, contradictory mailbox, malformed/oversized JSON-LD, hidden/script-derived email, changed/readback proof, inaccessible/robots denied, cross-domain linked page and two distinct contact links.

Prefer synthetic fictitious names/domains for regression tests; no real third-party content bundled into repo without rights.

**Acceptance criteria:**

- Each fixture has expected named identity, email (if allowed), evidence type and rejection code; manual independent adjudication for any real evidence.
- Baseline and candidate verifier evaluated on **identical** corpus with version/commit SHA.
- Zero false positives on the labeled negative corpus (mandatory gate, not a statistical guarantee).
- No regression on known valid fixtures or the existing multi-Person parser.
- Every newly accepted format has an independent proof of exact person-to-mailbox binding; proximity and shared domain alone never qualify.
- No weakening of robots/SSRF/DNS/redirect/size, tenant, digest or collision contracts.
- Output reports false negatives, false positives, inaccessible, unavailable labels and coverage; if real source HTML is absent, explicitly state that only **synthetic contract coverage** was measured.

**Decision rule:** reproducible false negatives justify the smallest correct verifier fix with regression coverage. If none, do not expand parsing speculatively; move to evidence acquisition strategy evaluation.

## Phase 2 — separately authorized paired benchmark (RD-05)

**Requires explicit CTO budget/legal/source approval; do not run from this plan.**

Cohort: 30 eligible professional identities with lawful evidence and known source conditions, stratified into 10 independent official profile hints, 10 official organization/team hints and 10 historically ambiguous/no-proof cases. Reuse identical identities across arms; randomize arm order and control timestamp drift. No scraping of inaccessible sites.

| Arm | Source search strategy | Provider |
| --- | --- | --- |
| Control | Current exact-person baseline | Existing approved Tavily/Gemini |
| A | Domain-first official contacts | Same provider/model and price |
| B | Email-evidence-first targeted queries | Same provider/model and price |
| C | Evidence-aware hybrid planning | Same provider/model and price |

A vendor-index comparison (e.g. Brave/Exa) is a **separate experiment**, requiring another approved provider adapter/monetary envelope. Do not silently mix provider and strategy effects.

**Measures and correct denominators:**

| KPI | Formula / interpretation |
| --- | --- |
| Discovered professionals | Distinct, cited eligible identities (not raw observations) |
| Accessible official sources | Readable official URL inspection attempts / official URL inspection attempts |
| Named mailbox evidence | Independently labeled person-email pairs accepted for review |
| Qualified / 100 candidates | 100 × unique qualified pairs / fixed cohort individuals |
| Qualified / 100 pages | 100 × unique qualified pairs / URL inspection attempts |
| Cost / qualified | (reserved/settled/provider-reported tracked separately) / qualified; **undefined** at 0 qualified |
| False positive rate | Inadmissible pairs among predicted qualified pairs, independently adjudicated |
| Runtime | Completion duration, p50/p95; plus total vendor calls |
| Failure causes | Separate reader errors, candidate mismatch, no-published-email, conflict, unknown |
| Spending certainty | Reserved vs settled vs unresolved; do not claim billing reconciliation without invoice |

**Provisional test success:** at least one additional independently qualified contact compared with baseline without false positives, and cost per qualified no worse than baseline when both denominators are positive. A 30-person pilot is a **screen**, not causal proof or a statistically powered guarantee; use uncertainty intervals and a larger preregistered confirmatory cohort before a production rollout.

## Engineering work ordering / dependencies

| Work | Priority | Depends on | Status / release gate |
| --- | --- | --- | --- |
| RD-01 Evidence Funnel Baseline | P0 | Existing audit provenance | CTO scope approved; offline/read-only, tests and exact-HEAD CI required |
| RD-02 Offline HTML Coverage Audit | P0 | Fixture rights and current verifier contract | CTO scope approved; synthetic-only acceptable with explicit limitations |
| RD-03 Verified Organization Binding | P1 | RD-01/02 decision | DEFERRED; separate evidence/identity schema and migration/RLS/upgrade review |
| RD-04 Evidence-Aware Source Planning | P1 | RD-03 where organization required | DEFERRED; reuse existing source planner/claim, freeze approvals, no paid replay |
| RD-05 Paired Search Benchmark | P1 | RD-01/02 and explicit spend/legal approval | **NOT AUTHORIZED** |

Any proposed code PR must have deterministic unit and integration coverage, exact-HEAD CI, safe clean-start/upgrade DB path if relevant, auth/revocation/retry/race checks, reviewed full-run termination and zero-send evidence. No deployment or merge without separate authorization.

## Research-only sign-off

The CTO approved research direction and **prioritized RD-01/RD-02**, not publication of new measured yield, new provider, new paid search, production read/write, DB migration or sending. This documentation PR contains only three Markdown files.
