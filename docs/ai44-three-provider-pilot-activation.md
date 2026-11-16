# AI Discovery — bounded three-provider pilot activation (2026-11-16)

## Allow-listed exact model/tool policies

| BYOK provider | Exact model | Billable tool unit | Application reservation / attempt |
| --- | --- | --- | --- |
| Anthropic | `claude-sonnet-4-6` | Web-search calls (max 3 via `max_uses`) | USD 4.00 |
| OpenAI | `gpt-4.1-mini` | Web-search calls (max 3 via Responses `max_tool_calls`) | USD 1.50 |
| Google | `gemini-2.5-flash` | Grounded prompts (one API request; search query count is not billable unit for Gemini 2.5) | USD 2.00 |

Pricing references verified 2026-11-16:
- https://platform.claude.com/docs/en/about-claude/pricing
- https://developers.openai.com/api/docs/pricing
- https://developers.openai.com/api/docs/models/gpt-4.1-mini
- https://ai.google.dev/gemini-api/docs/pricing
- https://ai.google.dev/gemini-api/docs/google-search

Versioned server-owned rate policies expire at 2026-12-01 00:00 UTC.
Every other model/tool is explicitly rejected. No caller-supplied price
or arbitrary model ID is ever accepted.

## Financial controls and rollout

The existing owner-wide PostgreSQL lock/reservation/settlement ledger covers
all partner workspaces for the same personal BYOK owner. An owner must save a
monthly USD budget **before** searching. For failed, uncertain, timeout,
partial, or unverified provider responses, the full conservative worst-case
reservation is retained; no implicit refund or "free search" claim.
The application budget is **not** a provider-enforced invoice hard cap.
External provider-side limits or prepayment remain recommended.

The `AI_WEB_RESEARCH_ENABLED=true` flag is a **separate, explicit staging
release action** after exact-HEAD CI and deploy readiness. It enables only
the exact models listed above; unsupported or unbudgeted users remain blocked.

Keep `AI_PUBLIC_CONTACT_INSPECTION_ENABLED` false until the source-policy
review passes. AI results are always review-only with no automatic import,
email enrichment ownership assertion, or outreach sending. Google Forms,
Sheets and Gmail permissions are unchanged.

## Smoke

1. Confirm app CI, disposable PostgreSQL upgrade and real network smoke PASS.
2. Deploy the exact merge commit to Render, confirm `live`, migrations and
   anonymous auth denial.
3. Enable the gated provider research; verify Gemini and OpenAI readiness
   requires personal keys and a saved owner-wide budget, and that unrelated
   models are rejected before charging.
4. For each provider, perform at most one manually approved small paid research
   request; verify authoritative citations, no unauthorized import/sending,
   reserve and conservative settlement and budget exhaustion behavior.
   No automated paid provider tests are run by CI.
