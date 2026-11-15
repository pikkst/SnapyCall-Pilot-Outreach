import test from "node:test";
import assert from "node:assert/strict";
import { evaluateResearchReconciliationAlert } from "../server/research-reconciliation-alert.js";

const cleared = {
  staleAfterMinutes: 5, pendingReservations: 0, pendingCents: 0,
  staleReservations: 0, staleCents: 0, oldestStaleAt: null,
  needsReview: false, currency: "USD", billingSource: "application-estimate",
  action: "manual-review-only",
};

test("clear reconciliation snapshot produces no alert", () => {
  assert.deepEqual(evaluateResearchReconciliationAlert(cleared), {
    requiresOperatorReview: false, severity: "none", staleCount: 0,
    estimatedHeldCents: 0, oldestStaleAt: null,
    currency: "USD", action: "none",
  });
});

test("stale cross-month reservations produce manual-review alert, never refund", () => {
  const result = evaluateResearchReconciliationAlert({
    ...cleared, pendingReservations: 3, pendingCents: 520,
    staleReservations: 2, staleCents: 470, needsReview: true,
    oldestStaleAt: "2026-10-31T23:55:00.000Z",
  });
  assert.deepEqual(result, {
    requiresOperatorReview: true, severity: "warning",
    staleCount: 2, estimatedHeldCents: 470,
    oldestStaleAt: "2026-10-31T23:55:00.000Z",
    currency: "USD", action: "investigate-with-provider-evidence",
  });
});

test("untrusted or inconsistent ledger summaries fail closed", () => {
  for (const data of [
    null, {}, { ...cleared, staleReservations: -1 },
    { ...cleared, pendingCents: "500" },
    { ...cleared, staleReservations: 1 },
    { ...cleared, staleReservations: 1, pendingReservations: 1,
      needsReview: true, oldestStaleAt: null },
    { ...cleared, staleCents: 1 },
    { ...cleared, currency: "EUR" },
    { ...cleared, billingSource: "external-invoice" },
    { ...cleared, action: "auto-refund" },
    { ...cleared, staleAfterMinutes: 0 },
    { ...cleared, needsReview: true },
  ]) assert.throws(() => evaluateResearchReconciliationAlert(data), TypeError);
});
