CREATE TABLE "CandidateEvidence" (
  "id" TEXT NOT NULL,
  "candidateId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "sourceUrl" TEXT NOT NULL,
  "normalizedUrl" TEXT NOT NULL,
  "note" TEXT,
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "capturedBy" TEXT NOT NULL DEFAULT 'admin',
  CONSTRAINT "CandidateEvidence_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CandidateEvidence_candidateId_kind_normalizedUrl_key"
  ON "CandidateEvidence"("candidateId", "kind", "normalizedUrl");
CREATE INDEX "CandidateEvidence_normalizedUrl_idx" ON "CandidateEvidence"("normalizedUrl");
CREATE INDEX "CandidateEvidence_candidateId_capturedAt_idx" ON "CandidateEvidence"("candidateId", "capturedAt");
ALTER TABLE "CandidateEvidence" ADD CONSTRAINT "CandidateEvidence_candidateId_fkey"
  FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
