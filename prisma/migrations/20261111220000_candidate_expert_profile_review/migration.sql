-- Preserve existing article provenance and do not automatically grant profile review.
ALTER TABLE "Candidate" ADD COLUMN "expertProfileUrl" TEXT;
ALTER TABLE "Candidate" ADD COLUMN "profileReviewed" BOOLEAN NOT NULL DEFAULT false;
