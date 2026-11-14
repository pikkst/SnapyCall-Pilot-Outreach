// Durable conservative search-attempt reservations.
// The Prisma transaction holds active membership lock while reserving both
// scopes; either scope hitting its limit rolls back both reservations.
export const RESEARCH_DAILY_USER_WORKSPACE_LIMIT = 2;
export const RESEARCH_DAILY_WORKSPACE_LIMIT = 100;
// Absolute backend safety ceilings, independent of any user preference.
export const RESEARCH_MAX_USER_DAILY_LIMIT = 100;
export const RESEARCH_MAX_CANDIDATES = 20;

export function validateResearchPreferences(input) {
  const dailyLimit = input?.dailyLimit;
  const maxCandidates = input?.maxCandidates;
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1 ||
      dailyLimit > RESEARCH_MAX_USER_DAILY_LIMIT ||
      !Number.isInteger(maxCandidates) || maxCandidates < 1 ||
      maxCandidates > RESEARCH_MAX_CANDIDATES) {
    throw new TypeError("Research limits must be within server safety ceilings");
  }
  return { dailyLimit, maxCandidates };
}

export async function lockedResearchPreferences(tx, userId) {
  // A concurrent preference update locks the same row and is serialized
  // against this reservation. An unset preference retains legacy defaults.
  const rows = await tx.$queryRaw`
    SELECT "dailyLimit", "maxCandidates" FROM "ResearchUserLimits"
    WHERE "ownerId" = ${userId} FOR UPDATE`;
  return rows.length === 1 ?
    validateResearchPreferences(rows[0]) :
    { dailyLimit: RESEARCH_DAILY_USER_WORKSPACE_LIMIT, maxCandidates: 10 };
}

export class ResearchQuotaExceeded extends Error {
  constructor() {
    super("Daily AI research attempt limit reached");
    this.name = "ResearchQuotaExceeded";
  }
}

export function utcResearchDay(now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("Invalid quota clock");
  }
  return now.toISOString().slice(0, 10);
}

export async function reserveResearchAttempt(tx, {
  workspaceId, userId, now = new Date(), dailyLimit = RESEARCH_DAILY_USER_WORKSPACE_LIMIT,
}) {
  validateResearchPreferences({ dailyLimit, maxCandidates: 10 });
  if (!/^[a-z0-9]{20,36}$/.test(workspaceId) ||
      !/^[a-z0-9]{20,36}$/.test(userId)) {
    throw new TypeError("Verified workspace and user identifiers required");
  }
  const day = utcResearchDay(now);
  const scopes = [
    { key: "workspace:" + workspaceId, limit: RESEARCH_DAILY_WORKSPACE_LIMIT },
    { key: "workspace-user:" + workspaceId + ":" + userId,
      limit: dailyLimit },
  ];
  const remaining = {};
  for (const scope of scopes) {
    // A single statement is concurrency-safe across Node instances and workers.
    // All SQL values are bound via Prisma's tagged template parameters.
    const rows = await tx.$queryRaw`
      INSERT INTO "ResearchDailyQuota" ("scopeKey", "dayUtc", "attempts")
      VALUES (${scope.key}, ${day}::date, 1)
      ON CONFLICT ("scopeKey", "dayUtc") DO UPDATE
      SET "attempts" = "ResearchDailyQuota"."attempts" + 1
      WHERE "ResearchDailyQuota"."attempts" < ${scope.limit}
      RETURNING "attempts"`;
    if (!Array.isArray(rows) || rows.length !== 1) throw new ResearchQuotaExceeded();
    remaining[scope.key.startsWith("workspace-user:") ? "userWorkspace" : "workspace"] =
      scope.limit - rows[0].attempts;
  }
  return { dayUtc: day, remaining };
}
