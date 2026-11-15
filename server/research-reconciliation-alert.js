// Pure operational alert policy. All totals must come from the privileged
// server-side aggregate query; never use client-supplied ledger numbers.
// This module decides when an alert is warranted, but does not send mail.
export const RECONCILIATION_STALE_MINUTES = 5;

export function evaluateResearchReconciliationAlert(overview) {
  const fields = ["pendingReservations", "pendingCents", "staleReservations", "staleCents"];
  if (!overview || fields.some(key =>
    !Number.isSafeInteger(overview[key]) || overview[key] < 0) ||
      overview.staleReservations > overview.pendingReservations ||
      overview.staleCents > overview.pendingCents ||
      overview.currency !== "USD" ||
      overview.billingSource !== "application-estimate" ||
      overview.action !== "manual-review-only" ||
      overview.staleAfterMinutes !== RECONCILIATION_STALE_MINUTES) {
    throw new TypeError("Invalid server reconciliation overview");
  }
  const needsReview = overview.staleReservations > 0;
  if (needsReview !== overview.needsReview ||
      (needsReview && typeof overview.oldestStaleAt !== "string") ||
      (!needsReview && overview.oldestStaleAt !== null)) {
    throw new TypeError("Inconsistent stale reservation status");
  }
  return {
    requiresOperatorReview: needsReview,
    severity: needsReview ? "warning" : "none",
    staleCount: overview.staleReservations,
    estimatedHeldCents: overview.staleCents,
    oldestStaleAt: overview.oldestStaleAt,
    currency: "USD",
    // Operators must reconcile with evidence, never auto-refund stale funds.
    action: needsReview ? "investigate-with-provider-evidence" : "none",
  };
}
