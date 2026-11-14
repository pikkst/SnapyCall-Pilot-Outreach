// Durable conservative search-attempt reservations.
// The Prisma transaction holds active membership lock while reserving both
// scopes; either scope hitting its limit rolls back both reservations.
export const RESEARCH_DAILY_USER_WORKSPACE_LIMIT = 2;
export const RESEARCH_DAILY_WORKSPACE_LIMIT = 10;

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

export async function reserveResearchAttempt(tx, { workspaceId, userId, now = new Date() }) {
  if (!/^[a-z0-9]{20,36}$/.test(workspaceId) ||
      !/^[a-z0-9]{20,36}$/.test(userId)) {
    throw new TypeError("Verified workspace and user identifiers required");
  }
  const day = utcResearchDay(now);
  const scopes = [
    { key: "workspace:" + workspaceId, limit: RESEARCH_DAILY_WORKSPACE_LIMIT },
    { key: "workspace-user:" + workspaceId + ":" + userId,
      limit: RESEARCH_DAILY_USER_WORKSPACE_LIMIT },
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
