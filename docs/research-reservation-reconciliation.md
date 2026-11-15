# Research reservation reconciliation runbook

## Status and scope

This is **operator guidance**, not an automated reconciliation mechanism.
Paid research remains disabled. The application ledger is not a provider invoice
and the partner budget screen is not an external billing cap.

## Detection

The existing partner `GET /api/research-budget` response includes:
- `ledger.reservedCents`: current UTC month's still-reserved amount;
- `ledger.settledCents`: current UTC month's internal settled estimate;
- `ledger.pendingReservations`: current UTC month's outstanding claims;
- `reconciliation.staleReservations`: all-month outstanding reservations
  created at least five minutes ago for the authenticated BYOK owner;
- `reconciliation.oldestPendingAt`: timestamp of the earliest unresolved
  reservation across all months;
- `reconciliation.needsReview`: whether an old reservation requires review.

The five-minute threshold exceeds the current 30-second upstream deadline.
It is an operational warning, **not** evidence that an upstream charge did
or did not occur. Detection is read-only and runs when the partner retrieves
the budget snapshot. There is no scheduler, notification delivery or auto-fix.

## Safe investigation

1. Identify the affected owner from an authenticated operator workflow;
   never paste a credential, raw API key, or contact email into incident logs.
2. Find aged `RESERVED` records in `ResearchSpendReservation`. Cross-check
   owner, workspace, original UTC month, reservation UUID, created time,
   and matching `ai.research-spend.reserved` audit event. Historical months
   must be included.
3. Check correlated application failures, lease expiry and provider request
   IDs if they were captured in provider-side logs. **A timed-out response is
   not proof of a free API call.** Some provider invoice events can lag.
4. If evidence is incomplete, keep the reservation; report its worst-case
   amount as internal reserved balance, not verified provider spend. Escalate
   for explicit review. Do not mutate `ResearchSpendMonth` directly.
5. If a future audited reconciliation operation is added, use the existing
   idempotent `settleOwnerSpend` transaction contract and the original
   reservation month. Never reissue provider requests as reconciliation.
   Record the external evidence and settlement decision in the audit log.

## Remaining implementation gate

Before enabling paid research, add owner-wide automated observability and
notifications for stale reservations, idempotent reconciliation operation
with operator authorization and evidence, crash/timeout simulations, and
provider-specific actual billing reconciliation. The current stale counter
is only an early warning, not a complete system.

## Admin diagnostics (read-only)

The existing admin-authenticated session can request
`GET /api/admin/research-reconciliation`. It reports the **aggregate**
pending/aged counts and USD-cent reservations for all owners and all months,
the oldest aged timestamp, and a manual-review status. It intentionally
returns no owner IDs, workspace IDs, candidate details or reservation IDs.
The response is `Cache-Control: no-store`; partner-only and unauthenticated
sessions must receive HTTP 401. Admin AI configuration does not grant
authority to spend a partner's BYOK balance.

The admin Settings screen provides a manual `Check pending charges`
control. This is a pull-based diagnostic and **does not** schedule scans,
automatically notify operators or change any ledger value. Clearing the
admin session also clears cached diagnostics in the browser.

A future proactive alert should use a separately approved scheduler and
authenticated operator notification transport, plus deduplication,
thresholds and tests. Never send raw financial identifiers, API credentials
or partner contact information in alert payloads.
