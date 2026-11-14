import test from "node:test";
import assert from "node:assert/strict";
import {
  utcBudgetMonth, validateMonthlyBudgetCents, reserveOwnerSpend,
  ResearchBudgetExceeded, settleOwnerSpend,
} from "../server/research-budget.js";

const ownerId = "c" + "a".repeat(24);
const workspaceId = "c" + "b".repeat(24);
const reservationId = "b53dcc07-9150-486f-89c3-5105c93c22cd";

test("USD cents validation is integral and strictly bounded", () => {
  assert.equal(validateMonthlyBudgetCents(100), 100);
  assert.equal(validateMonthlyBudgetCents(100_000), 100_000);
  for (const bad of [0, -1, 99, 100_001, 250.5, "500", null, NaN]) {
    assert.throws(() => validateMonthlyBudgetCents(bad));
  }
});

test("month boundary is UTC, including year rollover", () => {
  assert.equal(utcBudgetMonth(new Date("2026-12-31T23:59:59.999Z")).toISOString(),
    "2026-12-01T00:00:00.000Z");
  assert.equal(utcBudgetMonth(new Date("2027-01-01T00:00:00.000Z")).toISOString(),
    "2027-01-01T00:00:00.000Z");
  assert.throws(() => utcBudgetMonth(new Date(NaN)));
});

test("invalid or unpriced reservations are rejected before any ledger writes", async () => {
  let called = false;
  const tx = { $queryRaw: async () => { called = true; } };
  for (const data of [
    { ownerId: "not-a-cuid", workspaceId, reservationId, worstCaseCents: 10 },
    { ownerId, workspaceId, reservationId, worstCaseCents: 0 },
    { ownerId, workspaceId, reservationId, worstCaseCents: 2.7 },
    { ownerId, workspaceId, reservationId: "client-defined", worstCaseCents: 25 },
  ]) await assert.rejects(() => reserveOwnerSpend(tx, data), TypeError);
  assert.equal(called, false);
});

test("no configured personal budget blocks provider cost reservation", async () => {
  const tx = { $queryRaw: async () => [] };
  await assert.rejects(() => reserveOwnerSpend(tx, {
    ownerId, workspaceId, reservationId, worstCaseCents: 50,
  }), ResearchBudgetExceeded);
});
