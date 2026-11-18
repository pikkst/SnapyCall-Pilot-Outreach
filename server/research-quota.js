// Durable conservative search-attempt reservations.
// The Prisma transaction holds active membership lock while reserving both
// scopes; either scope hitting its limit rolls back both reservations.
export const RESEARCH_DAILY_USER_WORKSPACE_LIMIT = 2;
export const RESEARCH_DAILY_WORKSPACE_LIMIT = 100;
// Absolute backend safety ceilings, independent of any user preference.
export const RESEARCH_MAX_USER_DAILY_LIMIT = 100;
export const RESEARCH_MAX_CANDIDATES = 20;
export const RESEARCH_MAX_USER_CONCURRENCY = 3;
export const RESEARCH_MAX_WORKSPACE_CONCURRENCY = 5;
// AI provider calls have a 30-second deadline. Expired leases recover crashed workers.
export const RESEARCH_LEASE_SECONDS = 120;

export function validateResearchPreferences(input) {
  const dailyLimit = input?.dailyLimit;
  const maxCandidates = input?.maxCandidates;
  const maxConcurrent = input?.maxConcurrent ?? 1;
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1 ||
      dailyLimit > RESEARCH_MAX_USER_DAILY_LIMIT ||
      !Number.isInteger(maxCandidates) || maxCandidates < 1 ||
      maxCandidates > RESEARCH_MAX_CANDIDATES ||
      !Number.isInteger(maxConcurrent) || maxConcurrent < 1 ||
      maxConcurrent > RESEARCH_MAX_USER_CONCURRENCY) {
    throw new TypeError("Research limits must be within server safety ceilings");
  }
  return { dailyLimit, maxCandidates, maxConcurrent };
}

export async function lockedResearchPreferences(tx, userId) {
  // A concurrent preference update locks the same row and is serialized
  // against this reservation. An unset preference retains legacy defaults.
  const rows = await tx.$queryRaw`
    SELECT "dailyLimit", "maxCandidates", "maxConcurrent" FROM "ResearchUserLimits"
    WHERE "ownerId" = ${userId} FOR UPDATE`;
  return rows.length === 1 ?
    validateResearchPreferences(rows[0]) :
    { dailyLimit: RESEARCH_DAILY_USER_WORKSPACE_LIMIT, maxCandidates: 10, maxConcurrent: 1 };
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

// Read-only preflight for a new full-run. Both discovery and person-source
// paid searches share these quota counters. The claim transaction remains
// authoritative: a concurrent search can consume capacity after preflight.
export async function readResearchDailyCapacity(db, {
  workspaceId, userId, now = new Date(),
}) {
  if (!/^[a-z0-9]{20,36}$/.test(workspaceId) ||
      !/^[a-z0-9]{20,36}$/.test(userId)) {
    throw new TypeError("Verified research capacity scope required");
  }
  const day = utcResearchDay(now);
  const limits = await db.researchUserLimits.findUnique({
    where: { ownerId: userId }, select: { dailyLimit: true },
  });
  const personalLimit = limits?.dailyLimit ?? RESEARCH_DAILY_USER_WORKSPACE_LIMIT;
  if (!Number.isSafeInteger(personalLimit) || personalLimit < 1 ||
      personalLimit > RESEARCH_MAX_USER_DAILY_LIMIT) {
    throw new TypeError("Invalid persisted daily research limit");
  }
  const workspaceKey = "workspace:" + workspaceId;
  const userWorkspaceKey = "workspace-user:" + workspaceId + ":" + userId;
  const rows = await db.researchDailyQuota.findMany({
    where: { dayUtc: new Date(day + "T00:00:00.000Z"),
      scopeKey: { in: [workspaceKey, userWorkspaceKey] } },
    select: { scopeKey: true, attempts: true },
  });
  const usage = new Map();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.attempts) || row.attempts < 0 ||
        usage.has(row.scopeKey)) {
      throw new TypeError("Invalid persisted daily research quota");
    }
    usage.set(row.scopeKey, row.attempts);
  }
  const workspaceUsed = usage.get(workspaceKey) ?? 0;
  const personalUsed = usage.get(userWorkspaceKey) ?? 0;
  return Object.freeze({
    dayUtc: day,
    resetsAt: new Date(Date.parse(day + "T00:00:00.000Z") +
      24 * 60 * 60 * 1000).toISOString(),
    workspaceLimit: RESEARCH_DAILY_WORKSPACE_LIMIT,
    workspaceUsed,
    personalLimit,
    personalUsed,
    remaining: Math.min(
      Math.max(0, RESEARCH_DAILY_WORKSPACE_LIMIT - workspaceUsed),
      Math.max(0, personalLimit - personalUsed),
    ),
  });
}

// Persisted dispatch pacing shared by manual searches and agent campaigns.
export const RESEARCH_MIN_DISPATCH_INTERVAL_MS = 35_000;

export class ResearchPacingRequired extends Error {
  constructor(waitMs) {
    super("Research dispatch must wait for its next eligible start");
    this.name = "ResearchPacingRequired";
    this.code = "RESEARCH_PACING_WAIT";
    this.retryAfterSeconds = Math.max(1, Math.ceil(waitMs / 1000));
  }
}

export class ResearchConcurrencyExceeded extends Error {
  constructor() {
    super("Maximum active research searches reached");
    this.name = "ResearchConcurrencyExceeded";
  }
}

// Must run in the same transaction as the daily quota reservation, and after
// locking the live membership and user's preference row. The workspace row
// serializes starts by different users across all app instances.
export async function reserveResearchLease(tx, { workspaceId, userId, maxConcurrent }) {
  if (!/^[a-z0-9]{20,36}$/.test(workspaceId) ||
      !/^[a-z0-9]{20,36}$/.test(userId) ||
      !Number.isInteger(maxConcurrent) || maxConcurrent < 1 ||
      maxConcurrent > RESEARCH_MAX_USER_CONCURRENCY) {
    throw new TypeError("Verified research lease parameters required");
  }
  const workspace = await tx.$queryRaw`
    SELECT "id" FROM "Partner" WHERE "id" = ${workspaceId} FOR UPDATE`;
  if (workspace.length !== 1) throw new ResearchConcurrencyExceeded();
  // PostgreSQL database time is authoritative across Render instances.
  const counts = await tx.$queryRaw`
    SELECT COUNT(*)::int AS "workspace",
      COUNT(*) FILTER (WHERE "userId" = ${userId})::int AS "user"
    FROM "ResearchRunLease"
    WHERE "workspaceId" = ${workspaceId}
      AND "releasedAt" IS NULL AND "expiresAt" > NOW()`;
  if (counts.length !== 1 || counts[0].workspace >= RESEARCH_MAX_WORKSPACE_CONCURRENCY ||
      counts[0].user >= maxConcurrent) throw new ResearchConcurrencyExceeded();
  // Under the locked workspace row, every instance sees the previous
  // committed dispatch, including already released concurrency leases.
  // No budget, quota, or autonomous attempt is consumed on rejection.
  const recent = await tx.$queryRaw`
    SELECT GREATEST(0, CEIL(EXTRACT(EPOCH FROM
      ("createdAt" + ${RESEARCH_MIN_DISPATCH_INTERVAL_MS} * INTERVAL '1 millisecond'
        - NOW())) * 1000))::int AS "waitMs"
    FROM "ResearchRunLease" WHERE "workspaceId" = ${workspaceId}
    ORDER BY "createdAt" DESC LIMIT 1`;
  if (recent.length > 0 && recent[0].waitMs > 0) {
    throw new ResearchPacingRequired(recent[0].waitMs);
  }
  const { randomUUID } = await import("node:crypto");
  const id = randomUUID();
  await tx.$executeRaw`
    INSERT INTO "ResearchRunLease" ("id", "workspaceId", "userId", "expiresAt")
    VALUES (${id}, ${workspaceId}, ${userId}, NOW() + ${RESEARCH_LEASE_SECONDS} * INTERVAL '1 second')`;
  return id;
}

export async function releaseResearchLease(db, leaseId, workspaceId, userId) {
  if (typeof leaseId !== "string" || !/^[a-f0-9-]{36}$/.test(leaseId)) {
    throw new TypeError("Invalid research lease token");
  }
  return db.researchRunLease.updateMany({
    where: { id: leaseId, workspaceId, userId, releasedAt: null },
    data: { releasedAt: new Date() },
  });
}
