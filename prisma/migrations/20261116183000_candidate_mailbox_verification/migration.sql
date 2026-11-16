-- Technical mailbox provider evidence is distinct from DNS/MX checks.
-- No row grants identity, consent, onboarding eligibility or email sending.
CREATE TABLE "CandidateMailboxVerification" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "candidateId" TEXT NOT NULL,
  "emailNormalized" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "adapterVersion" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "reason" TEXT NOT NULL,
  "billableAttemptUncertain" BOOLEAN NOT NULL DEFAULT false,
  "checkedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CandidateMailboxVerification_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CandidateMailboxVerification_workspaceId_fkey" FOREIGN KEY
    ("workspaceId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CandidateMailboxVerification_candidateId_fkey" FOREIGN KEY
    ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CandidateMailboxVerification_candidateId_key"
  ON "CandidateMailboxVerification"("candidateId");
CREATE INDEX "CandidateMailboxVerification_workspaceId_expiresAt_idx"
  ON "CandidateMailboxVerification"("workspaceId", "expiresAt");
