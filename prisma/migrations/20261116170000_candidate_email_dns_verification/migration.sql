-- Read-only DNS observations are not proof of mailbox existence.
-- A candidate has exactly one current, email-bound verification snapshot.
CREATE TABLE "CandidateEmailVerification" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "candidateId" TEXT NOT NULL,
  "emailNormalized" TEXT NOT NULL,
  "checkType" TEXT NOT NULL DEFAULT 'DNS_MX',
  "status" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "reason" TEXT NOT NULL,
  "domainAcceptsMail" BOOLEAN,
  "checkedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CandidateEmailVerification_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CandidateEmailVerification_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CandidateEmailVerification_candidateId_fkey"
    FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CandidateEmailVerification_candidateId_key"
  ON "CandidateEmailVerification"("candidateId");
CREATE INDEX "CandidateEmailVerification_workspaceId_expiresAt_idx"
  ON "CandidateEmailVerification"("workspaceId", "expiresAt");
