// Fail-closed preflight for the RD-01 historical audit. Labels are never
// treated as authorization; database identity and effective read-only state
// are checked in the same transaction used by the snapshot loader.
import { requireWorkspaceMembership } from "./workspace-access.js";

const ID = /^c[a-z0-9]{10,40}$/;
const ALLOWED_ENVIRONMENTS = new Set(["local-read-only", "staging-read-only"]);
const TERMINAL_CAMPAIGN_STATUSES = new Set(["COMPLETED", "PARTIAL"]);
const AUDIT_TABLES = ["PartnerMembership", "ResearchCampaign", "ResearchCampaignObservation", "ResearchPersonSourceJob", "ResearchSpendReservation", "AuditEvent", "ResearchCampaignTask", "ResearchCampaignRun", "ResearchFullRun", "ResearchContactBatch", "ResearchContactBatchItem"];
const REQUIRED_SCHEMA = new Map([
  ["PartnerMembership", ["partnerId", "userId", "revokedAt"]],
  ["ResearchCampaign", ["id", "workspaceId", "ownerId", "status"]],
  ["ResearchCampaignObservation", ["campaignId"]],
  ["ResearchPersonSourceJob", ["campaignId"]],
  ["ResearchSpendReservation", ["id", "workspaceId", "ownerId"]],
  ["AuditEvent", ["action", "metadata"]],
  ["ResearchCampaignTask", ["campaignId", "status"]],
  ["ResearchCampaignRun", ["campaignId", "startedTasks"]],
  ["ResearchFullRun", ["campaignId", "status"]],
  ["ResearchContactBatch", ["campaignId", "status"]],
  ["ResearchContactBatchItem", ["batchId", "status"]],
]);

export function validateAuditSelection({ environment, campaignId, workspaceId, ownerId } = {}) {
  if (!ALLOWED_ENVIRONMENTS.has(environment)) throw new TypeError("Explicit read-only audit environment required");
  for (const [value, label] of [[campaignId, "campaignId"], [workspaceId, "workspaceId"], [ownerId, "ownerId"]]) {
    if (!ID.test(value ?? "")) throw new TypeError(`Valid ${label} required`);
  }
  return Object.freeze({ environment, campaignId, workspaceId, ownerId });
}

export async function checkAuditDatabase(tx, selection) {
  const expectedDatabase = selection.expectedDatabase;
  const expectedRole = selection.expectedRole;
  if (!expectedDatabase || !expectedRole) return Object.freeze({ ok: false, code: "AUDIT_DATABASE_IDENTITY_UNCONFIGURED" });
  const [identity] = await tx.$queryRaw`SELECT current_database() AS database, current_user AS role, current_setting('transaction_read_only') AS transaction_read_only, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls, has_schema_privilege(current_user, 'public', 'CREATE') AS schema_create, has_database_privilege(current_user, current_database(), 'CREATE') AS database_create FROM pg_roles r WHERE r.rolname = current_user`;
  if (!identity || identity.database !== expectedDatabase || identity.role !== expectedRole) return Object.freeze({ ok: false, code: "AUDIT_DATABASE_IDENTITY_MISMATCH" });
  const writePrivileges = await tx.$queryRaw`SELECT table_name, has_table_privilege(current_user, 'public.' || quote_ident(table_name), 'INSERT,UPDATE,DELETE,TRUNCATE') AS can_write FROM (VALUES ('PartnerMembership'), ('ResearchCampaign'), ('ResearchCampaignObservation'), ('ResearchPersonSourceJob'), ('ResearchSpendReservation'), ('AuditEvent'), ('ResearchCampaignTask'), ('ResearchCampaignRun'), ('ResearchFullRun'), ('ResearchContactBatch'), ('ResearchContactBatchItem')) AS tables(table_name)`;
  if (identity.transaction_read_only !== "on" || identity.rolsuper || identity.rolcreaterole || identity.rolcreatedb || identity.rolreplication || identity.rolbypassrls || identity.schema_create || identity.database_create || writePrivileges.some(row => row.can_write)) return Object.freeze({ ok: false, code: "AUDIT_ROLE_NOT_RESTRICTED" });
  const columns = await tx.$queryRaw`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('PartnerMembership', 'ResearchCampaign', 'ResearchCampaignObservation', 'ResearchPersonSourceJob', 'ResearchSpendReservation', 'AuditEvent', 'ResearchCampaignTask', 'ResearchCampaignRun', 'ResearchFullRun', 'ResearchContactBatch', 'ResearchContactBatchItem')`;
  const found = new Map();
  for (const row of columns) found.set(row.table_name, [...(found.get(row.table_name) ?? []), row.column_name]);
  const schemaCompatible = [...REQUIRED_SCHEMA].every(([table, required]) => required.every(column => found.get(table)?.includes(column)));
  if (!schemaCompatible) return Object.freeze({ ok: false, code: "AUDIT_SCHEMA_INCOMPATIBLE" });
  return Object.freeze({ ok: true, database: identity.database, role: identity.role, schemaCompatible });
}

export async function preflightHistoricalFunnelAudit(db, selection) {
  const scope = validateAuditSelection(selection);
  if (!db || typeof db.$transaction !== "function") throw new TypeError("Database client required");
  return db.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const database = await checkAuditDatabase(tx, selection);
    if (!database.ok) return database;
    const membership = await requireWorkspaceMembership(tx, { workspaceId: scope.workspaceId, userId: scope.ownerId });
    if (!membership) return Object.freeze({ ok: false, code: "WORKSPACE_ACCESS_REVOKED" });
    const campaign = await tx.researchCampaign.findFirst({ where: { id: scope.campaignId, workspaceId: scope.workspaceId, ownerId: scope.ownerId }, select: { id: true, status: true } });
    if (!campaign) return Object.freeze({ ok: false, code: "CAMPAIGN_NOT_FOUND" });
    if (!TERMINAL_CAMPAIGN_STATUSES.has(campaign.status)) return Object.freeze({ ok: false, code: "CAMPAIGN_NOT_TERMINAL" });
    return Object.freeze({ ok: true, scope, database: database.database, role: database.role, schemaCompatible: database.schemaCompatible, campaignStatus: campaign.status, readOnly: true });
  }, { isolationLevel: "RepeatableRead" });
}

