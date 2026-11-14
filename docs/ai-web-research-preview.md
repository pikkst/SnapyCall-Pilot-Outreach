# AI web research preview — deployed implementation and activation gates

## Current deployed staging contract

At staging commit `46bfd03d73bcfcdad8a7f9a5afe7874618a1e1f8`,
the **existing** partner-scoped `POST /api/discovery/ai-research?workspaceId=...`
can route to the signed-in partner's selected encrypted BYOK provider:
Anthropic (Messages native web search), OpenAI (Responses web search),
or Gemini (Google Search grounding). This is implemented code, **not**
permission to activate paid search.

`AI_WEB_RESEARCH_ENABLED` must equal the literal string `true`. Otherwise
the endpoint returns HTTP 503 before any provider call. Staging currently
keeps this flag OFF; partner UI may render the search form but submission
returns “AI web research has not been enabled for this environment”.
The legacy administrator session is **not authorized** to use the route;
a Google partner identity, active workspace membership and Origin validation
are required. Do not expose admin search by removing those checks.

## Provider and result boundaries

- Research uses the user's existing selected AI configuration and does
  not store or reveal unencrypted keys to the browser.
- A supported model name alone does not prove the selected provider/model
  can perform the requested tool call. Actual compatibility, price and
  chargeability must be verified separately for each model.
- Provider-native signed/canonical search citation or grounding evidence
  must back URLs. Model-generated URLs alone are not trusted citations.
- Returned candidates are strictly review-only. The result contract includes
  `imported:false`, `reviewRequired:true` and `sendingEnabled:false`.
  No personal contact consent, legal basis, contact permission, verified
  credentials or email is inferred.
- Search is bounded by a 30-second transport deadline, configured tool
  and output limits, per-user/workspace/day quota and concurrent leases.
  These bounds **do not constitute a monetary provider spending cap**.
- Candidate import and external outreach are separate, explicitly reviewed
  workflows. No automated scraping of restricted directories is authorized.

## Financial gate — blocking issue #44

The database now contains owner-wide monetary ledger tables and the partner
can save a monthly USD preference. **The paid research route does not yet
reserve or settle money through that ledger.** The UI correctly reports
`enforcedForPaidSearch:false`.

Do not change the environment flag to true until all release criteria in
`docs/research-owner-budget.md` pass: official exact-model pricing,
conservative worst-case reservation before a call, provider-authentic
settlement/uncertain-charge handling, cross-workspace concurrency and
idempotency tests, exact-HEAD CI and a separately authorized small real
provider staging smoke.

## Admin-versus-partner UI

Admin has free feed discovery and its own candidate review workflow; the
paid AI research form is on the Google-partner workspace's discovery screen.
This is intentional until the admin authorization and BYOK ownership
contract is designed. Do not create a parallel admin search endpoint,
impersonate a partner, or widen legacy admin authority to partner data.

## Staging smoke checklist (non-billable)

1. Partner Google login and workspace selection; member revocation fails
   closed and cannot reuse cached candidates from another workspace.
2. AI provider preference, key fingerprint, owner-scoped quotas and budget
   settings load without ever returning plaintext keys.
3. Submitting research while disabled returns HTTP 503 without reserving
   quota, spending money, writing candidate rows or invoking a provider.
4. Manual seed creates a review-pending candidate only; equivalent retry
   stays idempotent. Article or public page source is not automatically
   an independent professional profile.
5. Admin remains unauthorized to call paid partner research; attempts
   do not consume provider funds. Email sending remains disabled.

These are test requirements; documenting them is not evidence that each
browser/HTTP test was executed.
