// Fail-closed preflight for the RD-01 historical audit. Labels are never
// treated as authorization; database identity and effective read-only state
// are checked in the same transaction used by the snapshot loader.
import { requireWorkspaceMembership } from "./workspace-access.js";

const ID = /^c[a-z0-9]{10,40}$/;
const ALLOWED_ENVIRONMENTS = new Set(["local-read-only", "staging-read-only"]);

export function validateAuditSelection({ environment, campaignId, workspaceId, ownerId } = {}) {
  if (!ALLOWED_ENVIRONMENTS.has(environment)) throw new TypeError("Explicit read-only audit environment required");
  for (const [value, label] of [[campaignId, "campaignId"], [workspaceId, "workspaceId"], [ownerId, "ownerId"]]) {
    if (!ID.test(value ?? "")) throw new TypeError(`Valid ${label} required`);
  }
  return Object.freeze({ environment, campaignId, workspaceId, ownerId });
}

export async function preflightHistoricalFunnelAudit(db, selection) {
  const scope = validateAuditSelection(selection);
  if (!db || typeof db.$transaction !== "function") throw new TypeError("Database client required");
  return db.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const [identity] = await tx.$queryRaw`SELECT current_database() AS database, current_user AS role, current_setting('transaction_read_only') AS transaction_read_only`;
    if (!identity || identity.transaction_read_only !== "on") return Object.freeze({ ok: false, code: "READ_ONLY_NOT_ENFORCED" });
    const membership = await requireWorkspaceMembership(tx, { workspaceId: scope.workspaceId, userId: scope.ownerId });
    if (!membership) return Object.freeze({ ok: false, code: "WORKSPACE_ACCESS_REVOKED" });
    const campaign = await tx.researchCampaign.findFirst({ where: { id: scope.campaignId, workspaceId: scope.workspaceId, ownerId: scope.ownerId }, select: { id: true, status: true } });
    if (!campaign) return Object.freeze({ ok: false, code: "CAMPAIGN_NOT_FOUND" });
    return Object.freeze({ ok: true, scope, database: identity.database, role: identity.role, schemaCompatible: true, campaignStatus: campaign.status, readOnly: true });
  }, { isolationLevel: "RepeatableRead" });
}

