-- Persistent single-admin credential; the plaintext bootstrap secret is never stored.
CREATE TABLE "AdminCredential" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminCredential_pkey" PRIMARY KEY ("id")
);
