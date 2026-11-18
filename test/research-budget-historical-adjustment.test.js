import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { reserveOwnerSpend, readOwnerBudgetSnapshot, ResearchBudgetExceeded }
  from "../server/research-budget.js";

const ownerId = "c" + "a".repeat(24);
const workspaceId = "c" + "b".repeat(24);
const reservationId = "b53dcc07-9150-486f-89c3-5105c93c22cd";
const now = new Date("2026-11-18T12:00:00.000Z");
const monthUtc = new Date("2026-11-01T00:00:00.000Z");

function budgetTx({ settled = 1200, excluded = 1000, limit = 1000 } = {}) {
  const calls = { created: 0, updated: 0 };
  return {
    calls,
    $queryRaw: async () => [{ monthlyLimitCents: limit }],
    researchSpendReservation: {
      findUnique: async () => null,
      create: async () => { calls.created++; },
    },
    researchSpendMonth: {
      upsert: async () => ({ settledCents: settled, reservedCents: 0 }),
      update: async () => { calls.updated++; },
    },
    researchSpendAdjustment: {
      aggregate: async ({ where, _sum }) => {
        assert.equal(where.ownerId, ownerId);
        assert.deepEqual(where.monthUtc, monthUtc);
        assert.equal(where.classification, "LEGACY_TEST_ESTIMATE");
        assert.equal(_sum.excludedCents, true);
        return { _sum: { excludedCents: excluded } };
      },
    },
  };
}

test("audited test exclusions restore only effective owner budget", async () => {
  const tx = budgetTx();
  const result = await reserveOwnerSpend(tx, {
    ownerId, workspaceId, reservationId, worstCaseCents: 300, now,
  });
  assert.equal(result.status, "RESERVED");
  assert.equal(tx.calls.created, 1);
  assert.equal(tx.calls.updated, 1);
});

test("unclassified gross estimates continue to consume budget", async () => {
  const tx = budgetTx({ excluded: 0 });
  await assert.rejects(() => reserveOwnerSpend(tx, {
    ownerId, workspaceId, reservationId, worstCaseCents: 300, now,
  }), ResearchBudgetExceeded);
  assert.equal(tx.calls.created, 0);
});

test("invalid exclusions cannot create negative effective spend or unlock budget", async () => {
  for (const excluded of [1201, -1, 0.5]) {
    const tx = budgetTx({ excluded });
    await assert.rejects(() => reserveOwnerSpend(tx, {
      ownerId, workspaceId, reservationId, worstCaseCents: 1, now,
    }), TypeError);
    assert.equal(tx.calls.created, 0);
  }
});

test("owner snapshot distinguishes gross estimates, exclusions, and effective budget", async () => {
  const db = {
    researchOwnerBudget: {
      findUnique: async () => ({ monthlyLimitCents: 1000 }),
    },
    researchSpendMonth: {
      findUnique: async () => ({ reservedCents: 25, settledCents: 1200 }),
    },
    researchSpendReservation: {
      count: async () => 0,
      findFirst: async () => null,
    },
    researchSpendAdjustment: {
      aggregate: async () => ({ _sum: { excludedCents: 1000 } }),
    },
  };
  const snapshot = await readOwnerBudgetSnapshot(db, ownerId, now);
  assert.equal(snapshot.ledger.settledCents, 1200);
  assert.equal(snapshot.ledger.historicalTestExcludedCents, 1000);
  assert.equal(snapshot.ledger.effectiveSettledCents, 200);
  assert.equal(snapshot.ledger.availableCents, 775);
  assert.equal(snapshot.ledger.billingSource, "application-estimate");
});

test("backfill is restricted to reviewed test fixtures, not arbitrary settled costs", () => {
  const migration = readFileSync(new URL(
    "../prisma/migrations/20261118230000_ai98_historical_spend_adjustment/migration.sql",
    import.meta.url), "utf8");
  assert.match(migration, /research\.spend\.legacy_test_classified/);
  assert.match(migration, /"chargedCents" = 200/);
  assert.match(migration, /ON CONFLICT \("reservationId"\) DO NOTHING/);
  assert.doesNotMatch(migration, /UPDATE "ResearchSpendReservation"/);
  assert.doesNotMatch(migration, /UPDATE "ResearchSpendMonth"/);
});
