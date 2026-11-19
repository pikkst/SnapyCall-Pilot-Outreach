# AI98 source domain feedback — investigation and bounded correction

## Evidence from the completed 2026-11-19 campaign

Campaign `cmwn7medj0001f93k6t39mnz0`:
- 50/50 discovery calls, 158 observations, 150 distinct names, 73 URLs
- 158 email inspections: 125 shared citations, 30 unavailable public
  profiles, two ambiguous/not published, one missing exact named profile
- 40/40 person-source calls: 25 in initial approval, 15 in continuation
- 40 source URLs proposed, zero qualified named emails
- 38 rejected public-page checks: 25 `PUBLIC_PAGE_ROBOTS_REJECTED`,
  11 `PUBLIC_PAGE_REDIRECT_REJECTED`, two `PUBLIC_PAGE_TOO_LARGE`
- 21 of the 40 rejected source URLs used LinkedIn hostnames, three Toptal

The first issue is **source selection**, not worker liveness.
Do not retry already billed jobs, bypass robots, follow unsafe redirects,
label inferred emails as verified or automatically create contacts.

## Change: empirical source-host exclusions for subsequent paid searches

The existing source executor, after its normal immutable budget approval
and claim, reads at most 250 settled `SOURCE_UNAVAILABLE` source jobs
from the **same** campaign. A pure deterministic projector:
- accepts only strict HTTPS public DNS hostnames, stripping only `www.`
- counts host failures and excludes a host after at least two failures
- selects at most eight hosts by failure count then stable host ordering
- ignores uninspected, ambiguous, non-HTTPS, credential-bearing and
  malformed URLs
- preserves existing behavior on optional feedback-read failure

For **only the already-approved** dual-provider source research call,
the host list is passed through existing `researchTavilyGeminiCandidates`
and `runBoundedTavilyGemini3Stages` to Tavily Basic's documented
`exclude_domains` search parameter. The Gemini source prompt stays
unchanged: no hallucinated emails, extra instructions, retries or
untrusted domain list input.

All default/discovery Tavily requests keep their byte-for-byte request
shape when `excludeDomains` is omitted. Strict bounded input validation
happens before the potentially billable Tavily call. No new spending,
API, schema migration, user input, contact acceptance or sending.

## Non-goals and remaining evidence-quality work

This reduces repeated inaccessible results but **does not guarantee**
an independent named person-email source. Excluding a host after two
failures is a heuristic and may miss an accessible path on that host;
its measured impact on verified-email yield must be compared in a
controlled future campaign. If exclusions lead to zero usable search
results, do not expand the budget or replay the provider call.

A following PR should add independent official-domain attribution and
bounded contact-page discovery under the existing evidence and budget
contracts. Optional external email-finder providers need their own
approval/price model and should not be silently enabled.

## Verification/release

Exact-head CI and CTO review are required. **Do not merge or deploy this
separate agent quality PR automatically**: it changes future paid
search selection and should have explicit release approval.
No live provider calls or historical campaign edits are made here.
