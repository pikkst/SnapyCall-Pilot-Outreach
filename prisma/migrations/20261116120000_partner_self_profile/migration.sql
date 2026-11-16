-- Non-destructive profile fields owned by the authenticated PartnerUser.
-- Never store credentials or inferred email identity in this profile.
ALTER TABLE "PartnerUser"
  ADD COLUMN "jobTitle" TEXT,
  ADD COLUMN "organizationName" TEXT,
  ADD COLUMN "businessPhone" TEXT,
  ADD COLUMN "publicWebsite" TEXT,
  ADD COLUMN "emailSignature" VARCHAR(1000);
