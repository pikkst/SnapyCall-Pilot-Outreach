# AI98 RFC — Evidence-aware contact discovery

**Status:** PROPOSED, research direction approved by CTO; architecture implementation **not yet authorized**.  
**Date:** 2026-11-20. **Decision owner:** CTO. **No runtime changes in this PR.**

## Problem and target outcome

The current AI98 flow can discover names and links but repeatedly fails to produce independently attributable public professional person-email evidence. Historical examples include 39 Source jobs, 95 URL inspection attempts, 56 inaccessible pages and zero VERIFIED outcomes. The evidence source is [root-cause audit](AI98_CONTACT_DISCOVERY_ROOT_CAUSE_AUDIT.md); these numbers are not predictive of a new architecture's success.

Optimize **qualified named person–email pairs per campaign and cost**, not raw observations, searches, clicks or invented predicted contacts.

## Alternatives considered

| Option | Opportunity | Primary risk | Decision |
| --- | --- | --- | --- |
| A Person-first | Distinct professional identity and field | Profiles commonly omit personal mailboxes | Keep as an identity-discovery input |
| B Email-evidence-first | Starts with likely public mailbox proof | Ambiguous name / shared inbox | Test in a bounded cohort |
| C Domain-first | Official staff/contact directories and structured team records | Incorrect employer binding | Test only after independently sourced organization identity |
| D Multi-source correlation | Can validate identity across independent documents | Unsupported cross-page inference | Defer until a separately reviewed proof contract |
| E AI retrieval + deterministic extraction | AI ranks evidence; deterministic verifier accepts it | Parser coverage and source quality | **Preferred execution model** |

**Preferred direction:** B + C + E with A for identity discovery. This is a testable research recommendation, **not** a validated production improvement.

## Proposed architecture, integrated into existing pipeline

```text
one approved full-run
  -> DISCOVERY (bounded provider-cited person/source hints)
  -> evidence-aware source planning (existing planner, no duplicate worker)
       -> verified person evidence
       -> independently attributed organization when available
       -> evidence-type and source-access prioritization
  -> bounded authorized source research
       -> exact-person sources and official contact pages
       -> provider-cited, immutable retrieval manifest
  -> independent HTTPS inspection / HTML + JSON-LD evidence extraction
  -> exact person–mailbox proof, provenance + digest + collision check
       -> QUALIFIED_EVIDENCE (still requires human review)
       -> EXCEPTION with sanitized reason code
  -> existing Candidate review/acceptance; separate send eligibility
```

### Contracts and integration points

1. **Do not replace orchestration.** Reuse `research-full-run-stages.js`, `research-person-source-plan.js`, `research-person-source-executor.js`, `research-provider-adapters.js`, existing Source cycles, spend reservation, quotas and AI98 zero-yield terminal stop.
2. **First improve parser evidence coverage offline.** Verify the existing `candidate-direct-email-evidence.js`, `research-structured-person-evidence.js`, `research-linked-contact-proof.js` and `research-public-pages.js` against annotated immutable HTML fixtures. Existing multi-Person JSON-LD support should be reused, not reimplemented.
3. **Organization affiliation is a claim requiring its own evidence.** Before adding `organization` to an immutable observation/manifest, define allowed independent first-party evidence, source URL, retrieval date, policy version, identity collision, ownership and decay. Never infer employer/domain from LLM prose, a common surname, or a shared organization address.
4. **One provider source hint is not proof.** Output is a cited source ID/URL and relevance ranking only. Never store LLM-proposed emails as verified. The trusted reader and verifier must independently retrieve and classify.
5. **Strict same-person email attribution.** Accept only separately proven named and non-generic public mailbox association, with digest/source timestamp; reject name mentions, inferred email patterns, shared inboxes, conflicting emails, namesakes and stale readbacks. Do not weaken qualification to improve reported yield.
6. **Existing security boundary.** Preserve owner/workspace authorization before and after reads, idempotent claims, campaign row locks, retry-safe settlement, unknown-cost reconciliation, DNS/SSRF, HTTPS, robots, legal source access, redirects, max pages/bytes/time and budget hard stops.
7. **No implicit billing expansion.** New search-provider capability, extra paid call, new batch size or changed approval scope requires a reviewed versioned price/cost envelope and new owner authorization. No paid replay of historical immutable approvals.
8. **Separate legal gates.** `SOURCE_HINT` / `IDENTITY_CORROBORATED` / `PUBLIC_EMAIL_EVIDENCE` / `QUALIFIED_EVIDENCE` are *proposed logical labels*, not automatically new DB fields. `CONTACT_ACCEPTED` and `SEND_ELIGIBLE` are distinct controlled outcomes. Public contact discovery ≠ lawful outreach permission.

### Proposed diagnostics, privacy-safe

Add **only if required after RD-01** bounded aggregate fields for search-intent/source-type, provider hint count, verified accessible source count, robots/HTTP/DNS error classes, independently qualifying proof, denial reason, reserved/settled/uncertain cost, processing duration. Reuse existing audit aggregates first. No raw names, URLs, emails, page bodies, exception text or credentials in logs/telemetry. Any per-domain feedback persistence is deferred pending a separate purpose, access, retention and privacy review.

### Provider strategy

Existing bounded Tavily + Gemini 3 remains baseline. Independent Brave/Exa search indexes and Gemini native grounding warrant research, but **no provider switch** is authorized; never compare providers with different cohorts and claim a causal query improvement. Verify actual vendor pricing, API terms, capabilities and dated price versions immediately before any cost authorization. See [benchmark plan](AI98_DISCOVERY_BENCHMARK_PLAN.md).

## Non-goals

- Mass scraping, CAPTCHA/robots/login bypasses, contact scraping of prohibited sources.
- Fictitious email permutations, unverified email ownership or mailbox deliverability.
- Automatic Candidate insertion or email sending without existing approval.
- Parallel new pipeline, unrelated endpoint, external orchestration infrastructure, speculative database migration.
- Production write, automatic paid A/B, changing historical stopped/immutable jobs.

## Rollout sequence and gates

- **RD-01 P0** measured evidence funnel and denominator integrity; snapshot and tests.
- **RD-02 P0** offline HTML proof coverage vs manually labeled corpus; only fix demonstrable false negatives with strict tests.
- CTO decision: if false negatives are real, approve minimal existing-verifier fix; else determine whether additional official source discovery is justified.
- **RD-03 P1 deferred:** verified organization-binding contract, only if evidenced.
- **RD-04 P1 deferred:** adaptive evidence-aware planning using existing queue/approvals.
- **RD-05 P1 separate authorization:** matched-cohort provider/search benchmark, explicit financial/source/legal approval.

## Risk register

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Incorrect person-email attribution | HIGH | Deterministic per-person proof, collision fail-closed, labeled negative fixtures |
| Restricted/robots-denied sources | HIGH | Respect access controls; prefer independently permitted official sources |
| Unauthorized marketing/processing | HIGH | Purpose, legitimate basis/privacy review and separate SEND_ELIGIBLE gate |
| Unbounded provider charges | HIGH | Versioned approvals, exact provider tariff, ledger + AI98 stop |
| Cross-tenant PII leakage | HIGH | Owner-scoped fencing, safe aggregates, no identity logs |
| Employer/domain hallucination | HIGH | Independent affiliation source, no inferred email or `site:` |
| Historical manifest mutation | HIGH | Versioned new flows and clean-start/upgrade tests if a schema change is later approved |
| Vendor pricing or index drift | MEDIUM | Dated benchmarks, approval/version checks |

## Acceptance for moving beyond research

A labeled corpus and measured funnel must show either (a) verified parser false negatives with a narrow fix; or (b) unavailability/nonpublishing as predominant blocker with enough source-type evidence to justify domain/evidence-first paired benchmark. No contact yield uplift is claimed before that evidence exists.

Relevant technical baseline: [AI98_PERSON_CENTRIC_OFFICIAL_CONTACT_DISCOVERY.md](AI98_PERSON_CENTRIC_OFFICIAL_CONTACT_DISCOVERY.md), [AI98_BOUNDED_MULTI_SOURCE_EMAIL_EVIDENCE.md](AI98_BOUNDED_MULTI_SOURCE_EMAIL_EVIDENCE.md), [AI98_SOURCE_INSPECTION_OUTCOMES.md](AI98_SOURCE_INSPECTION_OUTCOMES.md), [AI98_AUTONOMOUS_CONTACT_PIPELINE.md](AI98_AUTONOMOUS_CONTACT_PIPELINE.md).
