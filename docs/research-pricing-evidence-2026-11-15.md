# AI research pricing evidence — engineering investigation (2026-11-15)

## Status

**Research activation is still blocked.** This is a source review, NOT
an approved dated price registry or an enforceable provider spending cap.
The runtime registry in `server/research-price-policy.js` intentionally
contains no enabled provider/model entries.

## Official references checked on 2026-11-15

- OpenAI API pricing: https://developers.openai.com/api/docs/pricing
  The `web_search` tool carries a per-search charge (currently shown as
  USD $10 / 1,000 calls) **plus** search-content token costs at the
  selected model's rates. A limit on generated output tokens does not bound
  search-content tokens unless the selected API/model/tool guarantees that
  bound. Do not assume three `web_search_call` result objects are proof
  of the maximum billed units for every model and tool version.
- Anthropic Claude pricing:
  https://platform.claude.com/docs/en/about-claude/pricing
  Web search is separately priced (currently USD $10 / 1,000 searches),
  in addition to model input/output tokens. Cache creation/read may have
  different token rates. The adapter currently returns only general
  input/output and search request counts; it does **not** return all cache
  usage fields needed for accurate discounted/provider-rated settlement.
- Gemini Developer API pricing:
  https://ai.google.dev/gemini-api/docs/pricing
  Gemini 2.5 Search grounding is metered per grounded prompt above its
  applicable free allowance (currently USD $35 / 1,000 grounded prompts).
  Newer Gemini models may instead be metered per search query and their
  paid/free allowances differ. The current adapter exposes query count,
  which is **not** a sufficient billing unit for Gemini 2.5.
  Provider pricing and free allowances may change at date or tier boundaries.

Prices above are **investigation snapshots**, not fixed contract constants.
Verify the exact provider/model/tool combination, account tier and date
again before approving a registry entry. External provider-side spend caps
are independent of the app's ledger.

## Implemented in draft PR #49

- `requireResearchPriceEnvelope` fails closed before a billable API call,
  lease or quota reservation when no approved tariff exists.
- `reserveOwnerSpend` uses the existing owner-wide PostgreSQL row lock
  inside the same transaction as lease/quota allocation.
- `calculateVerifiedSpendCents` uses integer accounting and rounds
  positive costs *up* to whole USD cents only if a reviewed tariff provides
  all required usage units and their limits. Uncertain, missing, out-of-bound
  or non-search-request billing units return `null` and the full worst-case
  amount is conservatively settled. Its synthetic test rates are **not**
  production tariffs.
- `settleOwnerSpend` preserves reserved costs when settlement fails.
  Existing quota failures trigger transaction rollback.

## Remaining release blockers

1. Build **exact-model, versioned provider capability and tariff entries**,
   with official evidence URLs, effective/expiry dates, request/input/tool
   hard bounds and independent CTO approval. Prove that each per-request
   worst-case bound includes all billable provider usage, search-generated
   context, caching, retries and possible token modifiers; otherwise do not
   approve the model.
2. Extend provider adapters to return **all authoritative billable units**
   applicable to their specific tariff. Compare to provider invoices where
   possible. No zero-cost settlement from incomplete usage.
3. Include a provider/tool/version-specific `billingUnit` and model
   capability checks. Gemini 2.5 grounded prompts must never be charged as
   per-query requests. Version every price reservation in durable audit.
4. Add exact-head HTTP+PostgreSQL active-flag fixture tests for rejected
   and accepted mocked provider runs, owner/workspace races, failure after
   provider call, UTC rollover, in-flight reconciliation and auth/CSRF.
5. Separate small real-provider staging smoke approved with a bounded test
   budget. **Do not** enable `AI_WEB_RESEARCH_ENABLED` or automatic sending
   as part of this investigation.
