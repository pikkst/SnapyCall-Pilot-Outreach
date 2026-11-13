-- Additive Google partner identities. Existing admin login and candidate data remain unchanged.
CREATE TABLE "Partner" (
  "id" TEXT NOT NULL, "name" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Partner_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "PartnerUser" (
  "id" TEXT NOT NULL, "emailNormalized" TEXT NOT NULL,
  "googleSub" TEXT, "displayName" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PartnerUser_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "PartnerMembership" (
  "id" TEXT NOT NULL, "partnerId" TEXT NOT NULL, "userId" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'PARTNER', "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PartnerMembership_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PartnerUser_emailNormalized_key" ON "PartnerUser"("emailNormalized");
CREATE UNIQUE INDEX "PartnerUser_googleSub_key" ON "PartnerUser"("googleSub");
CREATE UNIQUE INDEX "PartnerMembership_partnerId_userId_key" ON "PartnerMembership"("partnerId", "userId");
CREATE INDEX "PartnerMembership_userId_revokedAt_idx" ON "PartnerMembership"("userId", "revokedAt");
ALTER TABLE "PartnerMembership" ADD CONSTRAINT "PartnerMembership_partnerId_fkey"
 FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PartnerMembership" ADD CONSTRAINT "PartnerMembership_userId_fkey"
 FOREIGN KEY ("userId") REFERENCES "PartnerUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
