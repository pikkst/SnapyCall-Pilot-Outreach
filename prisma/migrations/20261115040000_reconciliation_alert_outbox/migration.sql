-- Durable, deduplicated operational alerts. No financial reservation is
-- settled, released, or modified by this table.
CREATE TABLE "ResearchReconciliationOutbox" (
  "dedupeKey" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "firstDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "staleCount" INTEGER NOT NULL,
  "estimatedHeldCents" INTEGER NOT NULL,
  "sentAt" TIMESTAMP(3),
  "providerId" TEXT,
  CONSTRAINT "ResearchReconciliationOutbox_pkey" PRIMARY KEY ("dedupeKey"),
  CONSTRAINT "ResearchReconciliationOutbox_status_check"
    CHECK ("status" IN ('PENDING', 'MANUAL_REVIEW', 'SENT')),
  CONSTRAINT "ResearchReconciliationOutbox_count_check" CHECK ("staleCount" > 0),
  CONSTRAINT "ResearchReconciliationOutbox_amount_check" CHECK ("estimatedHeldCents" > 0)
);
CREATE INDEX "ResearchReconciliationOutbox_status_firstDetectedAt_idx"
 ON "ResearchReconciliationOutbox" ("status", "firstDetectedAt");
