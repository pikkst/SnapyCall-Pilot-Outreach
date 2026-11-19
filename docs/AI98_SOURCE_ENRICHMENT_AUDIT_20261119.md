# AI98 source-enrichment audit — 2026-11-19

## Observed stopped-run evidence

Campaign `cmwmq6dck0001en3ljwqoiw23` was stopped by the owner and must not be
restarted, reconciled, replayed or rewritten as part of this change.

- Discovery: 100 completed searches, 244 observations, 214 distinct
  normalized names, 130 distinct citation URLs.
- Triage: 162 shared-source blocks, 80 inaccessible public profiles,
  2 ambiguous/unpublished addresses. No qualified email evidence.
- Source: 25 attempted; 12 no unique direct source, 12 public page
  inspection unavailable, 1 address ambiguous. Zero independently
  verified person-specific direct emails; 217 jobs remained queued.
- The captured Gemini 3 source-search payload requested **generic
  expert extraction** even when the paid task targeted Lorraine Burrell.
  Gemini returned Lorraine alongside Lorraine Buhannic, Kane Simms,
  Tshepo Moruakgomo and Alan Nichol. The worker's existing
  `proposedPersonSource` exact-name check rejected unrelated identities,
  but the broad prompt squandered extraction capacity.
- Some proposed URLs pointed at LinkedIn, YouTube, shared directories and
  other pages that the strict existing public-page adapter could not
  inspect. An inaccessible page **must not** be treated as proof of
  an absent email, or as permission to scrape blocked services.

## Changes

1. Preserve existing discovery extraction unmodified by default. For a
   person-source job only, pass a **trusted server-side** `sourceSubject`
   (name, category) into the bounded Tavily + Gemini 3 adapter. Build
   a deterministic target-only prompt against the same Tavily evidence
   manifest and countTokens preflight. Filter unrelated model-returned
   identities after immutable citation validation. Multiple exact-name
   URLs stay ambiguous in the downstream direct-source validator.
2. In the existing `planPersonSourceResolution`, suppress repeated paid
   queue jobs only when the name (NFKC/case-normalized), category AND
   exact citation URL match. Retain unresolved-observation counts and
   never merge potential namesakes across different citations.
3. Preserve owner/workspace authentication, immutable campaign approvals,
   price and token guards, atomic quota and budget reservations,
   idempotency, SSRF protection and email evidence acceptance.

## Limits / follow-up

These changes reduce irrelevant expert extraction and exactly duplicated
searches. They **do not** make LinkedIn or other inaccessible public
profiles readable, invent emails, certify identity from an LLM answer,
or guarantee any qualified contacts. A separate inspection-adapter
diagnostic should classify HTTP 403/429, timeout, unsupported content,
robots/access restrictions, mismatched redirect and invalid profile
without lowering existing security gates. It must not bypass gated pages
or auto-retry potentially billable calls.

The new planner applies only to newly prepared job manifests; it will
not rewrite the stopped campaign's frozen job snapshot. All changes
require exact-HEAD CI and review before merge; no paid smoke is part
of this patch.
