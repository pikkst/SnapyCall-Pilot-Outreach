# AI98 — Contact discovery root-cause audit

**Date:** 2026-11-20  
**Status:** Research report / CTO research direction approved; implementation not approved by this document  
**Scope:** SnapyCall Pilot Outreach, GitHub `main` at `c5c279b81e2b405f56abbd5ab1c7b8d3cbe1322a`; read-only Neon **pilot-staging** aggregate queries; historical repository audit documentation.

## Executive conclusion

The evidence acquisition funnel is the limiting factor. The system finds professional identities and source hints, but many cited pages cannot be independently inspected, and many readable pages do not expose an unambiguous named person-to-email association. Increasing source search volume without first measuring and fixing those gaps is not justified. An evidence-aware, domain-aware strategy is a **hypothesis to benchmark**, not a demonstrated yield improvement.

**Evidence classifications:** `OBSERVED` = measured in the identified environment; `CODE-CONFIRMED` = directly observed implementation contract; `HYPOTHESIS` = causal explanation or improvement not yet measured.

## Historical campaign example (not generalizable)

Repository's source-quality audit describes campaign `cmwobfiis0001j83nxljoymqj`:

| Metric | Value |
| --- | ---: |
| Discovery calls | 10 |
| Paid source jobs | 39 |
| Cited URL inspections | 95 |
| URL reads unavailable | 56 |
| Robots rejections within unavailable reads | 51 |
| Readable URLs without qualifying named-person email evidence | 39 |
| Independently verified email evidence | 0 |

**Source:** [AI98_SOURCE_QUALITY_GATE_2026-11-20.md](AI98_SOURCE_QUALITY_GATE_2026-11-20.md). The document calls this a production audit; the current researcher's independent aggregation was performed on the connected **pilot-staging branch**, where this campaign also appears. Environment labels must not be silently merged into a claim of independently verified production traffic. The denominator 95 is **URL inspection attempts**, not unique people or source jobs.

The preceding large stopped-run audit describes 100 Discovery calls, 244 observations and 25 attempted Source jobs, with 162 shared-source triage blocks and 80 inaccessible public profiles. **Source:** [AI98_SOURCE_ENRICHMENT_AUDIT_20261119.md](AI98_SOURCE_ENRICHMENT_AUDIT_20261119.md). These samples are heterogeneous and do not establish a population-wide yield.

## Independently queried pilot-staging aggregate snapshot

Read-only Neon SQL on project `snapycall-pilot-outreach`, branch `pilot-staging`, restricted to campaigns whose `ResearchCampaign.createdAt >= '2026-11-19'::timestamp`:

```sql
SELECT COALESCE(j."lastErrorCode", '(none)') AS reason,
       count(*)::int AS jobs
FROM "ResearchPersonSourceJob" j
JOIN "ResearchCampaign" c ON c.id = j."campaignId"
WHERE c."createdAt" >= '2026-11-19'::timestamp
  AND j.attempts > 0
GROUP BY 1
ORDER BY jobs DESC;
```

| Persisted lastErrorCode | Attempted jobs |
| --- | ---: |
| SOURCE_MIXED_UNQUALIFIED | 63 |
| PUBLIC_PAGE_INSPECTION_UNAVAILABLE | 61 |
| SOURCE_ALL_PAGES_UNAVAILABLE | 40 |
| SOURCE_NO_NAMED_EMAIL_EVIDENCE | 29 |
| NO_UNIQUE_DIRECT_SOURCE | 22 |
| SOURCE_NO_MATCHING_CITED_PROFILE | 16 |
| ADDRESS_AMBIGUOUS_OR_NOT_PUBLISHED | 6 |
| NAMED_EMAIL_EVIDENCE_REVIEW_REQUIRED | 1 |
| **Total** | **238** |

The same campaign window's observations grouped by `emailTriageStatus`: `BLOCKED=456`, `NO_EMAIL=73`, `REVIEW_REQUIRED=1` (**530** observations total). These are **stage-specific statuses**, not a confirmed qualified or send-eligible contact count. Multiple historical pipeline versions use different reason-code granularity; do **not** equate `PUBLIC_PAGE_INSPECTION_UNAVAILABLE` with a particular current URL reader error without provenance.

**Source:** read-only connected Neon queries performed 2026-11-20; these numbers are an environment-limited snapshot, not immutable CI fixtures or current live production metrics. No names, emails, source URLs or payloads were fetched.

## Root-cause register

| ID | Classification | Evidence | Consequence | Next discriminating test |
| --- | --- | --- | --- | --- |
| RC-01 Profile-first rather than email-evidence-first source selection | CODE-CONFIRMED design limitation | `research-person-source-executor.js` query uses exact name + reason-conditioned search intent; source-targeted Gemini prompt favors cited exact-person sources | Identity discovery is not equivalent to finding published mailbox proof | RD-01 per source-type funnel |
| RC-02 Inaccessible candidate documents | OBSERVED | 56/95 pages unavailable in historical campaign; 51 robots denials | Search-result URL may not be legally or technically readable | RD-01 reader failure categories by attempted URL |
| RC-03 Readable documents lack sufficient proof | OBSERVED | 39/95 inspected URLs readable without required attribution | More page reads may yield no contacts | RD-02 labeled HTML offline corpus |
| RC-04 No independently verified organization in approved observation snapshot | CODE-CONFIRMED | [AI98_PERSON_CENTRIC_OFFICIAL_CONTACT_DISCOVERY.md](AI98_PERSON_CENTRIC_OFFICIAL_CONTACT_DISCOVERY.md) | Cannot safely derive employer domain / `site:` query | RD-03 evidence contract, only after benchmark |
| RC-05 Potential verifier false negatives on legitimate published formats | HYPOTHESIS | Existing bounded named-email, JSON-LD and linked-page support is intentionally conservative | Valid contact cards might be missed; **no measured FN rate** | RD-02 manual gold labels vs current verifier |
| RC-06 Unavailable-domain feedback data mismatch | CODE-CONFIRMED | `repeatedUnavailableSourceDomains` requires `SOURCE_UNAVAILABLE` + `proposedSourceUrl`; actual failed jobs often have `COMPLETED` + reason, no persisted denied URL | Previously rejected hosts cannot reliably be excluded | RD-01 quantify available sanitized feedback; separate privacy-approved design |
| RC-07 Incorrectly rejected independently valid email evidence | HYPOTHESIS | No labeled production HTML with independently adjudicated expected outputs was inspected | Cannot assert verifier is too strict | RD-02 gold corpus |
| RC-08 Search provider insufficiency | HYPOTHESIS | No matched-cohort provider comparison | Provider change may add cost but not qualified yield | RD-05, separately authorized |

## Existing code contracts (do not duplicate)

- `server/research-provider-adapters.js`: bounded Tavily retrieval manifest, source-ID integrity, Gemini 3 text-only extraction, trusted `sourceSubject`; no AI-generated email accepted as proof.
- `server/research-person-source-executor.js`: bounded source claim, reason-conditioned query, up to three provider-cited inspected URLs, per-call spend/lease fences, independent source checks.
- `server/research-public-pages.js`: HTTPS/public-DNS/robots/redirect/content constraints, limited linked same-host contact URL recognition and HTML normalization.
- `server/research-linked-contact-proof.js`: explicit source root + at most one independent same-host linked contact read; no cross-document concatenation of person name and email.
- `server/research-structured-person-evidence.js`: explicit single- and multi-Person schema.org JSON-LD support already exists; do not claim it is absent.
- `server/research-observation-email.js`, `server/research-qualified-evidence.js`: independent readback, digest, scope/collision rules; research qualification != contact acceptance != sending eligibility.
- `server/research-source-domain-feedback.js`: historic status-dependent domain feedback gap.

## Evidence limitations

1. No exhaustive read of original production DB; Neon **pilot-staging** aggregate queries only.
2. No historical raw HTML, source contact data or provider response retained in this research report.
3. No offline gold corpus evaluated against current verifier; therefore no measured false-negative or false-positive rate.
4. No new paid web/API requests or paired controlled benchmark.
5. Pricing/provider effectiveness and yield improvements remain hypotheses until independently verified.

## Recommendation / decision gate

Approve RD-01 (funnel measurement) and RD-02 (offline HTML evidence coverage audit) **as research/engineering scope only**. Do not approve paid searches, new provider, expanded crawler, direct marketing or data migration from this document. If an admissible false-negative is reproduced, fix the existing parser/contract with regression coverage; otherwise assess RD-03/RD-04 domain-first and email-evidence-first discovery against an approved controlled cohort.

See [AI98_EVIDENCE_AWARE_DISCOVERY_RFC.md](AI98_EVIDENCE_AWARE_DISCOVERY_RFC.md) and [AI98_DISCOVERY_BENCHMARK_PLAN.md](AI98_DISCOVERY_BENCHMARK_PLAN.md).
