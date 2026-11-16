-- Independently inspected named public profile evidence, REVIEW_REQUIRED only.
-- This table never changes Candidate.email/contactReviewed or send eligibility.
CREATE TABLE "CandidateDirectEmailObservation" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "candidateId" TEXT NOT NULL,
  "personName" TEXT NOT NULL,
  "emailNormalized" TEXT NOT NULL,
  "profileUrl" TEXT NOT NULL,
  "evidenceDigest" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'REVIEW_REQUIRED',
  "inspectedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CandidateDirectEmailObservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CandidateDirectEmailObservation_workspaceId_fkey" FOREIGN KEY
    ("workspaceId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CandidateDirectEmailObservation_candidateId_fkey" FOREIGN KEY
    ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CandidateDirectEmailObservation_candidateId_key"
  ON "CandidateDirectEmailObservation"("candidateId");
CREATE INDEX "CandidateDirectEmailObservation_workspaceId_inspectedAt_idx"
  ON "CandidateDirectEmailObservation"("workspaceId", "inspectedAt");
