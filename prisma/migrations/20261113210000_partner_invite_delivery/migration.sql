-- Delivery attempts are separate from authorization; a failed email never revokes access.
CREATE TABLE "PartnerInviteDelivery" (
  "id" TEXT NOT NULL,
  "membershipId" TEXT NOT NULL,
  "emailNormalized" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "deliveryKey" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "claimedAt" TIMESTAMP(3),
  "sentAt" TIMESTAMP(3),
  "providerMessageId" TEXT,
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PartnerInviteDelivery_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PartnerInviteDelivery_membershipId_key" ON "PartnerInviteDelivery"("membershipId");
CREATE UNIQUE INDEX "PartnerInviteDelivery_deliveryKey_key" ON "PartnerInviteDelivery"("deliveryKey");
CREATE INDEX "PartnerInviteDelivery_status_claimedAt_idx" ON "PartnerInviteDelivery"("status", "claimedAt");
ALTER TABLE "PartnerInviteDelivery" ADD CONSTRAINT "PartnerInviteDelivery_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "PartnerMembership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
