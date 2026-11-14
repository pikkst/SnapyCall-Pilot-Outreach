# #44 — Owner-wide BYOK currency ledger, foundation stage

## Financial boundary

Research budgets are **owned by the authenticated BYOK user**, never by a
single workspace or AI provider. An owner using the same credential in multiple
authorized workspaces receives only one combined UTC monthly limit. PostgreSQL
stores integral USD cents to match the official pricing currency; EUR conversion
is not offered as a guaranteed exchange rate or billing cap.

The separate `GET/PUT /api/research-budget` endpoint permits the authenticated
Google partner (not legacy admin) to store a USD $1–$1000 monthly preference.
This is a **preference only** in the current stage: API results explicitly
report `enforcedForPaidSearch:false`. The paid research flag remains OFF.
Do not claim that provider spending is currently governed by this form.

## Reserve and settle transaction contract

`ResearchOwnerBudget` holds the mutable owner cap and is a cross-workspace
PostgreSQL lock target. `ResearchSpendMonth` stores reserved and settled USD
cents for an owner/UTC month. `ResearchSpendReservation` is a server-issued
idempotency record containing owner, workspace, original month, reserved upper
bound, settled amount and status.

`reserveOwnerSpend(tx, ...)` must be called only by server-side request
orchestration after workspace membership validation, and only after a
**verified/versioned provider/model/tool-specific maximum USD cost** has been
computed. The method locks the owner budget row before comparing
`settledCents + reservedCents + worstCaseCents` to the user's cap. This serializes
budget claims by two workspaces running on different Node instances.

`settleOwnerSpend(tx, ...)` also holds the owner lock. A provider timeout or
unreliable billing metadata settles at the **full reserved amount**, avoiding
phantom refunds. Settlements are idempotent, including explicit conflict
rejection on a mismatched second amount. The original reservation's UTC month
is used even if the result arrives in a new month. Lowering the user's cap
never resets already consumed balance. In-flight requests stay reserved until
the server can reconcile them; there is deliberately no expiry that silently
frees possibly billed costs.

## IMPORTANT — not yet a production monetary cap

No provider-specific price registry has been approved and the adapter outputs
do not yet prove bounded, billable tool usage in every provider. The ledger is
**not wired to chargeable AI calls**, intentionally. Requesting `AI_WEB_RESEARCH_ENABLED`
activation without an implemented and tested price-envelope reserve/settle
integration must be rejected.

Three providers have materially different billing semantics:

- OpenAI: per tool call plus model and search-content tokens. Particular
  smaller models can have special web search context input token blocks
  (https://developers.openai.com/api/docs/pricing).
- Gemini 2.5: search grounding uses a separate grounded-prompt billing model;
  newer Gemini versions may bill individual search queries, and free tiers
  vary by account (https://ai.google.dev/gemini-api/docs/pricing).
- Claude: provider tokens and web-search tool billing require independent
  validated pricing and authoritative usage fields before charging.

An upper bound must cover provider-specific tool-call caps, output and input
context, cached content where applicable, search tokens and retries. If no
reliable upper bound exists, **deny paid research**, even with unused quota.
Prompt-generated estimated token counts are not authoritative usage.
A provider's actual invoice may differ from application estimates; advise users
to configure provider-side hard spend controls as well.

## Evidence and release gates

Unit and disposable PostgreSQL HTTP smoke validate user-only settings,
CSRF, invalid caps, concurrent cross-workspace reservations, idempotency,
conflicting settlement, conservative timeout/unknown-usage accounting and
lowering limits after spend.

Next stage: approved tariff registry and capability matrix, trust-boundary
usage verification, wallet integration into the existing research route,
observability, reconciliation/recovery of abandoned reservations, provider
pricing expiry and authorized real-provider smoke with explicit small budgets.

No automated source scraping, contact import, external email or paid API
requests are part of this foundation.

## Stage 2 implementation handoff — release blocking

The latest merged staging release is `46bfd03d73bcfcdad8a7f9a5afe7874618a1e1f8`.
The existing `POST /api/discovery/ai-research` currently reserves a workspace
lease and daily attempt, **not** an owner currency amount. This means the
`ResearchOwnerBudget`, `ResearchSpendMonth` and `ResearchSpendReservation`
tables are a foundation only, regardless of a USD preference shown in the UI.
Do not enable `AI_WEB_RESEARCH_ENABLED` based on the existence of these tables.

### Required, smallest integration

1. Introduce a server-only, dated and versioned capability/price definition
   for each provider, exact model and web-search tool combination. A provider
   wildcard, model name regex or client-supplied quote is **not** a price
   guarantee. Pricing must be checked against the current official provider
   documentation and approved before enabling an entry; expired or incomplete
   entries must fail closed. All three providers must be independently audited.
2. Bound every billable resource *before* reserving: prompt/input size,
   response tokens, maximum tool calls, provider-specific search/grounding
   units, request retries and any provider-imposed minimum charges. If the
   provider offers no enforceable upper bound for one call, keep that provider
   unavailable. Version the calculated envelope alongside its reservation
   audit evidence; do not depend on mutable live pricing for historical audits.
3. Within the **existing** research route and a single PostgreSQL transaction,
   authenticate partner identity, lock active membership, acquire quota and
   lease, then reserve the owner-wide worst-case USD cents using
   `reserveOwnerSpend` before any provider call. A missing budget, unsupported
   model, insufficient funds, or reservation error must make zero paid calls.
   A concurrency or budget rejection must not consume a daily attempt.
4. After the call, settle with `settleOwnerSpend` using only authenticated
   provider usage/grounding evidence and the correct versioned tariff. On
   timeout, network ambiguity, malformed/missing usage or crash, never
   release uncertain costs as zero. Track interrupted reservations for manual
   reconciliation, without automatic expiration of potentially billed amounts.
   Record audit and request correlation IDs without persisting credentials.
5. Preserve the user's original UTC reservation month across rollovers.
   Handle parallel workspaces, API-key replacement, membership revocation
   during a request, price changes, replay and concurrent owner-limit edits.
   The existing lease cleanup must remain idempotent even if cost settlement
   fails; failures must be visible to operations.
6. Show the user application-governed **estimated** spend, reserved amount,
   known settled amount and explicit warning that the provider's external
   invoice is not strictly capped by this app. Never label a preference an
   enforceable provider billing limit.

### Evidence required for activation

- Deterministic price-fixture tests for each *exact* supported model/tool:
  normal result, missing tokens, missing tool-count, truncated/incomplete
  response, provider error, timeout and unknown billed usage.
- Disposable PostgreSQL clean-start and upgrade tests: owner budget shared
  across workspaces, parallel reserve/settle, rejected budget without provider
  call or daily-attempt charge, idempotency conflict, lower-after-spend, UTC
  month rollover and crash/retry handling.
- Auth/Origin and membership-revocation races; no admin-session access to
  partner-scoped BYOK and no credential/PII leakage to logs or UI.
- Exact-HEAD CI, explicit CTO-reviewed official price evidence, then a
  separately approved small real-provider staging smoke for each enabled
  provider. Provider-side spending safeguards should also be configured.

### Admin and partner UI contract

The existing route explicitly rejects legacy admin sessions after checking
the feature flag. Do **not** bypass this with admin credentials or silently
reuse a partner's BYOK key. Admin web research needs an explicit authenticated
owner/workspace authorization model and should reuse the same research
orchestration and evidence contract, not a duplicate endpoint. The partner
view may show the unavailable feature, but should not present a runnable paid
search when its backend release gate is OFF.

No automatic candidate import, Gmail outreach sending, or expansion of
restricted-directory scraping is part of #44.
