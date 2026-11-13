-- Invitation delivery metadata never grants membership access by itself.
ALTER TABLE "PartnerMembership"
  ADD COLUMN "inviteStatus" TEXT NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "inviteAttempt" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "inviteAttemptAt" TIMESTAMP(3),
  ADD COLUMN "inviteLeaseUntil" TIMESTAMP(3),
  ADD COLUMN "inviteSentAt" TIMESTAMP(3),
  ADD COLUMN "inviteProviderId" TEXT,
  ADD COLUMN "inviteErrorCode" TEXT,
  ADD COLUMN "acceptedAt" TIMESTAMP(3);
-- Existing invited Google identities have already completed identity verification.
UPDATE "PartnerMembership" m SET "acceptedAt" = CURRENT_TIMESTAMP
FROM "PartnerUser" u
WHERE m."userId" = u."id" AND m."revokedAt" IS NULL AND u."googleSub" IS NOT NULL;
