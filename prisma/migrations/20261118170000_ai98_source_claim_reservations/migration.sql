-- Preserve the monetary and concurrency reservation identities across worker restarts.
-- RUNNING or expired source jobs must be reconciled, never silently replayed.
ALTER TABLE "ResearchPersonSourceJob"
  ADD COLUMN "spendReservationId" UUID,
  ADD COLUMN "researchLeaseId" UUID;
CREATE UNIQUE INDEX "ResearchPersonSourceJob_spendReservationId_key"
  ON "ResearchPersonSourceJob"("spendReservationId");
