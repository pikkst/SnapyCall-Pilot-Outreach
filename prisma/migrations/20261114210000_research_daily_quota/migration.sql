-- One row per UTC day and scope. A counted attempt is not refunded if a provider fails.
CREATE TABLE "ResearchDailyQuota" (
    "scopeKey" TEXT NOT NULL,
    "dayUtc" DATE NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ResearchDailyQuota_pkey" PRIMARY KEY ("scopeKey", "dayUtc"),
    CONSTRAINT "ResearchDailyQuota_attempts_check" CHECK ("attempts" >= 0)
);
