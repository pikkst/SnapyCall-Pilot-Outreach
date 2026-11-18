# AI98 — historical test-price budget adjustments

## Cause and evidence

On 2026-11-18 the pilot-staging owner-budget ledger held 175 settled
reservations, gross USD 193.52: 87 at USD 2.00, 84 at USD 0.03,
three at USD 4.00 and one at USD 5.00. The owner identified the
old USD/EUR ~2.00 per-request entries as test pricing, not real
invoices. Append-only `AuditEvent` records
`research.spend.legacy_test_classified` were created for precisely
87 settled 200-cent reservations. Another 84 records were flagged
`CONSERVATIVE_ESTIMATE`; four high-value records remain unclassified.

The owner separately reported ~EUR 0.50 total project cost and ~EUR
0.008 per request for a particular test. Both are **owner-reported,
not provider-invoice verified**, and are intentionally *not* allocated
retroactively to specific provider calls. USD app limits cannot be
converted from EUR with a hard-coded FX rate. Retain these values as
external, precisely represented evidence in audit metadata
(`reportedProjectCostMilliEur=500`;
`indicativeActualEurMilliPerRequest=8`).

## Corrective accounting contract

- `ResearchSpendReservation` and `ResearchSpendMonth` remain unchanged
  and immutable. They represent conservative internal budget commitments.
- A new `ResearchSpendAdjustment` row records the excluded USD cents for
  a uniquely identified, already reviewed reservation. Only
  `LEGACY_TEST_ESTIMATE` is permitted. The migration backfills rows
  only if matching append-only classification evidence already exists,
  the original reservation is `SETTLED` and both amounts equal 200 cents.
  Re-running the backfill is safe.
- All new owner budget reservations continue taking the *existing*
  `ResearchOwnerBudget FOR UPDATE` lock. Available budget is computed
  from `reservedCents + settledCents - historicalTestExcludedCents`;
  inconsistency (excluded greater than settled) fails closed.
- `GET /api/research-budget` retains the gross `settledCents` for
  backward compatibility, and returns `historicalTestExcludedCents`,
  `effectiveSettledCents` and adjusted `availableCents`.
  UI explicitly labels all of these as internal estimates, **not**
  provider invoices. There is no new writable endpoint.
- Classifications are not deductions from actual invoices. The 84
  conservative 3-cent entries and the four unclassified higher-price
  entries remain within enforced app budgeting until independently
  reviewed; their gross amount remains visible.
- Any future per-call externally verified cost should use a dedicated
  provider evidence record with currency, source, invoice/usage reference,
  and sub-cent precision (integer micro-EUR or micro-USD). Do not copy the
  owner's global EUR 0.50 estimate into 175 unrelated USD reservations.

## Release and verification

No migration has been applied merely by opening this PR. Before merge,
check Prisma schema/migration consistency, unit tests, clean-start and
upgrade migration smoke. The existing Render startup runs
`prisma migrate deploy`, so releasing will alter the *effective* owner
budget capacity for the 87 audited items. Do not simultaneously enable
AI98 executor flags or run paid searches. After migration verify:

```sql
SELECT count(*) AS adjusted_count, sum("excludedCents") AS excluded_cents
FROM "ResearchSpendAdjustment";
```

Expected on the current pilot-staging snapshot: 87 adjustments,
17,400 USD cents excluded from the original 19,352 USD cents gross,
yielding 1,952 USD cents effective internal estimate. This **USD
19.52 is still not the true EUR 0.50 project bill**. The difference
remains deliberately unreconciled rather than fabricated.
