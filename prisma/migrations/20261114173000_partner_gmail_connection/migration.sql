-- A Gmail send grant belongs to a verified Google user, not a candidate,
-- shared workspace, admin identity, or existing Forms/Sheets grant.
CREATE TABLE "PartnerGmailConnection" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "googleSub" TEXT NOT NULL,
  "encryptedRefreshToken" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PartnerGmailConnection_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PartnerGmailConnection_userId_key" ON "PartnerGmailConnection"("userId");
ALTER TABLE "PartnerGmailConnection" ADD CONSTRAINT "PartnerGmailConnection_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "PartnerUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
