-- A discovered candidate may be queued before a durable source is identified.
-- Null represents missing verified provenance, never a synthetic URL.
ALTER TABLE "Candidate" ALTER COLUMN "sourceUrl" DROP NOT NULL;
