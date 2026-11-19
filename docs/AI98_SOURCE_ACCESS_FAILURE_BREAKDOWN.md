# AI98 source-access failure breakdown

## Evidence from production run (2026-11-19)
Read-only query on the connected Neon project `snapycall-pilot-outreach`, branch
`pilot-staging`, campaign `cmwnhr3w50001h03ly4i1l9gj`:

- 20 settled person-source jobs: 9 `SOURCE_ALL_PAGES_UNAVAILABLE`,
  6 `SOURCE_MIXED_UNQUALIFIED`, 3 `SOURCE_NO_MATCHING_CITED_PROFILE`,
  2 `SOURCE_NO_NAMED_EMAIL_EVIDENCE`.
- 7 additional jobs remained queued; full run ended
  `PARTIAL / SOURCE_CONTINUATION_BUDGET_EXHAUSTED`.
- Independent email triage audit: 9 `PROFILE_INSPECTION_UNAVAILABLE`,
  4 `NO_EXPLICIT_NAMED_PROFILE`,
  3 `ADDRESS_AMBIGUOUS_OR_NOT_PUBLISHED`.

The previous source job audit distinguished *how many* pages were inaccessible
but not *why*, preventing a measured decision about whether to improve
redirect support, content parsing, DNS compatibility or robots behavior.

## Change
Preserve the existing one approved paid search, maximum three cited roots and
one linked-contact attempt. Add immutable, bounded counters to
`AuditEvent.metadata.sourceInspection.accessFailures`:
`robots`, `redirect`, `dns`, `http`, `timeout`, `content`, `linked`,
`other`. Every unavailable read maps to exactly one category. Categories are
derived from allowlisted exceptions emitted by the trusted public reader;
unknown errors map to `other`. The linked counter identifies failures during
the optional contact read, without persisting exception text.

No raw exception, hostname, URL, email, person name, page content or provider
response is written to this audit diagnostic. The existing settlement
transaction validates all keys and integers (each 0–3), and requires category
sum to equal unavailable count before entering the transaction.

## Compatibility and release
- No DB migration, new API, new AI request, additional HTTP read or changed
  budget/lease/auth/CAS contract.
- Previous audit records lack `accessFailures`; analytics must tolerate null.
- Existing `lastErrorCode`, independent verification and human review rules
  are unchanged.
- Run `npm run check`, `npm test`, `npm run typecheck` and Pilot app CI.
- After review and deployment, a **separately approved** budgeted run is needed
  to measure the new categories. Do not infer historical failure types.

## Next technical decision
Prioritize one focused source-access fix based on the dominant counter, subject
to robots/SSRF and public access rules. Do not relax person-to-email proof or
increase paid search limits merely because this run returned zero contacts.
