-- AI98: immutable, audit-backed exclusions from the *effective* owner budget.
-- Never rewrite settled reservations or ResearchSpendMonth financial history.
CREATE TABLE "ResearchSpendAdjustment" (
  "reservationId" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "monthUtc" DATE NOT NULL,
  "excludedCents" INTEGER NOT NULL,
  "classification" TEXT NOT NULL,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ResearchSpendAdjustment_positive_check" CHECK ("excludedCents" > 0),
  CONSTRAINT "ResearchSpendAdjustment_class_check"
    CHECK ("classification" IN ('LEGACY_TEST_ESTIMATE'))
);
CREATE INDEX "ResearchSpendAdjustment_ownerId_monthUtc_idx"
  ON "ResearchSpendAdjustment" ("ownerId", "monthUtc");

-- Backfill only explicitly reviewed, precisely matching $2.00 test fixtures.
-- Do not infer test status from price alone or alter uncertain/provider costs.
-- DISTINCT protects against duplicated append-only audit observations.
INSERT INTO "ResearchSpendAdjustment"
  ("reservationId", "ownerId", "monthUtc", "excludedCents", "classification")
SELECT DISTINCT r.id, r."ownerId", r."monthUtc", r."chargedCents",
       'LEGACY_TEST_ESTIMATE'
FROM "ResearchSpendReservation" r
JOIN "AuditEvent" a
  ON a."entityId" = r.id
 AND a.action = 'research.spend.legacy_test_classified'
WHERE r.status = 'SETTLED'
  AND r."chargedCents" = 200
  AND r."reservedCents" = 200
  AND a.metadata->>'classification' = 'LEGACY_TEST_ESTIMATE'
  AND a.metadata->>'budgetAdjusted' = 'false'
ON CONFLICT ("reservationId") DO NOTHING;
