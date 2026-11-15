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

## Opt-in machine-readable monitor (not a notification sender)

For an operator-managed runtime with a restricted database read credential,
`RESEARCH_ALERT_CHECK_ENABLED=true npm run research:reconciliation-check`
checks the global, read-only aggregate. Outputs sanitized JSON with no
tenant identifiers or secrets. Exit codes: `0` clear or disabled,
`2` aged reservations require review, `1` configuration/query failure.
An absent enable flag performs **no database query**.

This command is not scheduled by default, does not send emails, and does not
change monetary balances. To enable proactive delivery later, first implement
and validate a persistent idempotent outbox, authenticated operator recipient,
independent scheduler and retry-safe provider delivery. Do not run it with a
production write-enabled database URL from a public CI job. The current
internal reserve/settle ledger remains distinct from provider billing.

The partner UI now labels remaining funds as an *estimated application
budget* rather than a guaranteed provider cap.

## Durable outbox (no delivery)

The `ResearchReconciliationOutbox` table records pending incidents across
process restarts. No user IDs, workspace IDs, reservation IDs, API credentials,
recipient addresses or contact data are stored in the outbox.

For explicitly authorized operator jobs only, execute:

```sh
RESEARCH_ALERT_ENQUEUE_ENABLED=true npm run research:reconciliation-enqueue
```

Without the flag it returns `{"status":"disabled"}` and accesses no
database. The command does **not** send any email, change financial records
or schedule itself. Its output is aggregate operational metadata only.

The enqueue function reads the oldest stale reservation and an aggregate
snapshot in a serializable PostgreSQL transaction, derives a SHA-256
incident key from that reservation's internal ID, and inserts with a
unique conflict fence. Repeated or concurrent checks of the same unresolved
incident do not create duplicate rows. Transient serialization conflicts
have a bounded retry. Already-existing `PENDING`, `SENT` and
`MANUAL_REVIEW` states are never reset by re-enqueueing.

**Important:** an outbox row is a record of an earlier observation. The
underlying reservation could be settled before a future dispatcher runs.
Any dispatcher MUST re-check that the incident still needs review before
sending. An actual email dispatcher will also need an explicit recipient,
signed provider idempotency key, durable lease/attempt state, retry window,
provider receipt, and a manual-review fallback for ambiguous sends.
Do not activate sending or schedules based solely on this migration.

## Required rollout

Use clean-start and upgrade migrations against disposable PostgreSQL,
verify concurrent enqueue and process replay, then deploy with enqueue
disabled. Enable operator jobs only after a scoped DB credential and
deployment-specific access controls are approved. Keep provider research
and automatic outreach disabled.

## Operator-only email delivery (explicit gate, not enabled)

The private CLI `npm run research:reconciliation-deliver` requires
`RESEARCH_ALERT_DELIVERY_ENABLED=true`, a database connection, and a
separately configured `RESEARCH_ALERT_FROM`, `RESEARCH_ALERT_TO`, and
`RESEND_API_KEY`. It never shares or reuses a partner's BYOK key, never
sends candidate outreach, and must not be run with production credentials
from public CI. No scheduled trigger or public HTTP endpoint exists.

The dispatcher uses a 120-second persistent lease and compare-and-swap
updates. Immediately before contacting Resend it rechecks that the oldest
stale reservation still corresponds to the incident. Each attempt uses
exactly one fixed Resend Idempotency-Key per incident. A timeout or
ambiguous provider response becomes FAILED and may retry the same key
only inside the 23-hour local safety window; after the window or three
attempts, it requires MANUAL_REVIEW. A confirmed Resend response means
provider acceptance, not inbox delivery. No automatic refund occurs.

The outbox records `PENDING`, `SENDING`, `FAILED`, `SKIPPED`,
`MANUAL_REVIEW` and `SENT` states. Sending stays disabled by default.
The migration remains unapplied outside disposable CI until reviewed,
merged and deployed with the two explicit opt-in flags OFF.

**Known boundary:** the final stale check and external network call
cannot be a single atomic transaction. If the reservation resolves
immediately after the check, a warning can still be accepted. No
financial mutation results from that warning. A later scheduler needs
runbook/recipient owner, provider reconciliation, notification
observability and negative-path smoke before activation.
