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
