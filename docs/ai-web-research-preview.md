# AI web research preview — initial review-only contract

Depends on PR #24, which introduces `anthropic` in the existing BYOK provider
adapter. This iteration uses Anthropic's native Messages API
`web_search_20250305` with `max_uses: 3`; it does **not** create a second
LLM account, separate API key store, or candidate import pipeline.

## Activation
`AI_WEB_RESEARCH_ENABLED` must be exactly `true`, otherwise the endpoint
returns 503 and makes no provider call. Keep false until CTO approval,
confirmed Google partner membership, permissioned research source policy,
budget controls and staging testing. A user must set an encrypted personal
Claude API key before invoking the research. Search incurs provider charges.

Existing endpoint:
`POST /api/discovery/ai-research?workspaceId=<active-workspace>`
body `{ "query": "...", "limit": 10 }`.
The workspace is verified from signed partner session and active membership.
Admin legacy identity, ambiguous admin + partner identity, invalid CSRF
origin, unknown tenant, and missing Anthropic BYOK key fail closed.

## Output and safety
- Up to 20 **review-only** candidate previews; each must include an exact
  URL from Anthropic web search **citation metadata**. URLs only written by
  the model are rejected.
- No email address, consent, legal basis, candidate row, evidence row, or
  outreach draft is created or inferred.
- No sending endpoint exists or is activated.
- Untrusted web content cannot supply new API hosts, outbound recipients,
  instructions or tool arguments.
- One call is capped at 3 provider web searches, 3200 response tokens and
  30 seconds, plus 2 requests/minute per HTTP source IP and global API limits.
  Token usage and search request count are returned for visibility.
- Provider may return fewer than 10 candidates, including zero; cite quality
  does not prove the personal identity or live contact rights.

## Remaining gates before any public activation
1. Persistent per-user/workspace/day spend budget and provider-specific
   exact pricing / charge reconciliation; IP rate limits alone are not a
   sufficient cost-control mechanism.
2. Test full tenant path, BYOK auth and feature flag against HTTP+PostgreSQL;
   enable staging only after authorized smoke.
3. Manual approval/import contract with reviewed evidence, legal basis and
   provenance. No automatic email harvesting.
4. Add Gemini and OpenAI search adapters behind shared domain contract,
   without pretending they are supported by this first Claude-only iteration.
5. Persist versioned research evidence and idempotent reuse once required.
