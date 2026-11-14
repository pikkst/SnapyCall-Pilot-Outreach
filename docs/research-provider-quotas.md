# AI Research provider routing and quotas — issue #40 Phase C

The existing `POST /api/discovery/ai-research?workspaceId=...` route now selects
the **authenticated user's** configured `gemini`, `openai`, or `anthropic`
provider and model through the shared research contract. Existing BYOK encryption
and exact workspace authorization remain unchanged. The browser cannot choose
another user's provider, key, or workspace identity.

## Rollout

`AI_WEB_RESEARCH_ENABLED` is **disabled by default**. This delivery must not
enable it in Render or other production environments.

Even with the flag enabled, the endpoint reserves a durable attempt before each
provider call, with one UTC-day quota per workspace (10) and one per
workspace/user (2). The two reservations are atomic in one transaction; revoked
members cannot reserve. A rejected request has no provider charge. Provider
errors after reservation still consume an attempt to fail conservatively.

This is an **attempt and request-volume limit**, NOT a monetary spending cap.
Different providers and models price tokens and grounded searches differently.
A successful provider response may also vary in actual tool-search count.
The flag must remain off until actual currency budgets, provider billable usage,
rollback policy, cost alerts, real-API smoke with explicitly limited funds,
and reviewer approval are complete. The default rate limit also remains in place.

## Data and migrations

`ResearchDailyQuota` stores `scopeKey`, UTC `dayUtc` and `attempts`.
Prisma's migration creates a single composite primary key and constraint.
No API key, raw prompt, contact or PII are stored in this table.
Concurrent Node instances use a bounded atomic SQL upsert under a real
PostgreSQL transaction; no in-memory rate/cost approximation.

## Invariants

- Research never auto-imports, merges, contacts or sends email.
- Sources must be provider-attributed; unverified email is always null.
- Unsupported provider/model combinations fail before spending or quota reserve.
- Account switching or workspace switching never displays stale research results.
- The API reports remaining attempt quota in its successful response.
- Users cannot escalate from partner to legacy admin or read another tenant.
- Changes to Google Forms/Sheets and Gmail consent are out of scope.

## Tests

CI runs mocked Anthropic/OpenAI/Gemini response tests and disposable PostgreSQL
concurrent reservation tests, including exhausted user quota rollback and
separate workspace budgets. Before paid rollout, verify the provider-specific
web search tools with controlled, real keys and explicit financial controls.
