-- Google API permissions are explicitly granted per partner workspace and user.
-- No legacy candidate or AI settings ownership is changed by this migration.
CREATE TABLE "PartnerGoogleConnection" (
  "id" TEXT NOT NULL,
  "partnerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "googleSub" TEXT NOT NULL,
  "encryptedRefreshToken" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PartnerGoogleConnection_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PartnerGoogleConnection_partnerId_userId_key" ON "PartnerGoogleConnection"("partnerId", "userId");
CREATE INDEX "PartnerGoogleConnection_userId_idx" ON "PartnerGoogleConnection"("userId");
ALTER TABLE "PartnerGoogleConnection" ADD CONSTRAINT "PartnerGoogleConnection_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PartnerGoogleConnection" ADD CONSTRAINT "PartnerGoogleConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "PartnerUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
