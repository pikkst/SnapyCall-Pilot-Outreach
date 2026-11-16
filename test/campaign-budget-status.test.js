import test from "node:test";
import assert from "node:assert/strict";
import { describeCampaignBudget } from "../src/campaign-budget-status.js";

const budget = (remaining, options = {}) => ({
  monthlyLimitCents: 10_000, enforcedForPaidSearch: remaining >= 200,
  ledger: { availableCents: remaining, pendingReservations: 0 },
  reconciliation: { needsReview: false }, ...options,
});

test("zero budget is exhausted, never missing and never a Google invoice", () => {
  const state = describeCampaignBudget(budget(0), true);
  assert.equal(state.code, "BUDGET_EXHAUSTED");
  assert.match(state.message, /\$0\.00 remaining of \$100\.00/);
  assert.match(state.message, /not the Google Gemini invoice/);
});
test("unconfigured budget and AI key show different corrective actions", () => {
  assert.equal(describeCampaignBudget(budget(900), false).code, "AI_KEY_MISSING");
  assert.equal(describeCampaignBudget(budget(900, { monthlyLimitCents: null }), true).code,
    "BUDGET_MISSING");
});
test("a remaining balance below model price ceiling is blocked but configured", () => {
  const state = describeCampaignBudget(budget(100), true);
  assert.equal(state.code, "MODEL_OR_BUDGET_BLOCKED");
  assert.doesNotMatch(state.message, /not configured/);
});
test("pending spend needs review before running", () => {
  const state = describeCampaignBudget(budget(1000, {
    ledger: { availableCents: 1000, pendingReservations: 1 },
  }), true);
  assert.equal(state.code, "BILLING_REVIEW");
});
test("valid budget reports remaining balance without promising provider charges", () => {
  const state = describeCampaignBudget(budget(8400), true);
  assert.equal(state.code, "READY");
  assert.match(state.message, /\$84\.00 remaining of \$100\.00/);
  assert.match(state.message, /not the Gemini invoice/);
});
