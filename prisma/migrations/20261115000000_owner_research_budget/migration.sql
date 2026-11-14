-- Billing amounts are integral USD cents, never floating-point.
-- A monetary budget is owner-scoped across all partner workspaces and AI providers.
CREATE TABLE "ResearchOwnerBudget" (
  "ownerId" TEXT NOT NULL,
  "monthlyLimitCents" INTEGER NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ResearchOwnerBudget_pkey" PRIMARY KEY ("ownerId"),
  CONSTRAINT "ResearchOwnerBudget_limit_check" CHECK ("monthlyLimitCents" BETWEEN 100 AND 100000)
);
CREATE TABLE "ResearchSpendMonth" (
  "ownerId" TEXT NOT NULL,
  "monthUtc" DATE NOT NULL,
  "reservedCents" INTEGER NOT NULL DEFAULT 0,
  "settledCents" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "ResearchSpendMonth_pkey" PRIMARY KEY ("ownerId", "monthUtc"),
  CONSTRAINT "ResearchSpendMonth_reserved_check" CHECK ("reservedCents" >= 0),
  CONSTRAINT "ResearchSpendMonth_settled_check" CHECK ("settledCents" >= 0)
);
CREATE TABLE "ResearchSpendReservation" (
  "id" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "monthUtc" DATE NOT NULL,
  "reservedCents" INTEGER NOT NULL,
  "chargedCents" INTEGER,
  "status" TEXT NOT NULL DEFAULT 'RESERVED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settledAt" TIMESTAMP(3),
  CONSTRAINT "ResearchSpendReservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ResearchSpendReservation_reserved_check" CHECK ("reservedCents" > 0),
  CONSTRAINT "ResearchSpendReservation_charged_check"
    CHECK ("chargedCents" IS NULL OR ("chargedCents" >= 0 AND "chargedCents" <= "reservedCents")),
  CONSTRAINT "ResearchSpendReservation_status_check" CHECK ("status" IN ('RESERVED','SETTLED'))
);
CREATE INDEX "ResearchSpendReservation_ownerId_monthUtc_status_idx"
  ON "ResearchSpendReservation" ("ownerId", "monthUtc", "status");
