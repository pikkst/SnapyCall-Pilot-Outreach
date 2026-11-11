ALTER TABLE "Candidate" ADD COLUMN "discoveryKey" TEXT;
CREATE UNIQUE INDEX "Candidate_discoveryKey_key" ON "Candidate"("discoveryKey");
