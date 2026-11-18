// Reversible contact removal: preserves immutable provenance, drafts, audit
// and billable research. Neither removing nor restoring authorizes sending.
import { isWorkspaceId, lockActiveWorkspaceMembership }
  from "./workspace-access.js";

const CUID = /^c[a-z0-9]{10,40}$/;

export async function changeCandidateRemoval(db, {
  candidateId, workspaceId, actorId, remove,
}, { now = new Date() } = {}) {
  if (!CUID.test(candidateId ?? "") ||
      !(workspaceId === null || isWorkspaceId(workspaceId)) ||
      typeof actorId !== "string" || actorId.length === 0 ||
      (workspaceId === null ? actorId !== "admin" : actorId === "admin") ||
      typeof remove !== "boolean" ||
      !(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("Authenticated, owner-scoped contact action required");
  }
  return db.$transaction(async tx => {
    if (workspaceId !== null && !await lockActiveWorkspaceMembership(tx, {
      workspaceId, userId: actorId,
    })) return { status: 403, code: "WORKSPACE_ACCESS_REVOKED" };
    // Lock the contact row to serialize removal with restore and ensure no
    // duplicate audit events from concurrent or repeated button actions.
    const matches = await tx.$queryRaw`
      SELECT "id", "removedAt" FROM "Candidate"
      WHERE "id" = ${candidateId}
        AND "workspaceId" IS NOT DISTINCT FROM ${workspaceId}
      FOR UPDATE`;
    if (matches.length !== 1) {
      return { status: 404, code: "CANDIDATE_NOT_FOUND" };
    }
    const alreadyRemoved = matches[0].removedAt !== null;
    if (alreadyRemoved === remove) {
      return { status: 200,
        code: remove ? "CANDIDATE_ALREADY_REMOVED" : "CANDIDATE_ALREADY_ACTIVE",
        changed: false, removed: remove, sendingEnabled: false };
    }
    // The update cannot cross tenant boundaries, even if the row was changed
    // between its original UI rendering and this request.
    const update = await tx.candidate.updateMany({
      where: { id: candidateId, workspaceId,
        removedAt: remove ? null : { not: null } },
      data: { removedAt: remove ? now : null,
        removedBy: remove ? actorId : null },
    });
    if (update.count !== 1) {
      throw new Error("CANDIDATE_REMOVAL_CAS_CONFLICT");
    }
    await tx.auditEvent.create({ data: {
      actorId, entityId: candidateId,
      action: remove ? "candidate.removed" : "candidate.restored",
      metadata: { workspaceId, retainedResearchHistory: true,
        mailSendingAuthorized: false, permanentErasure: false },
    } });
    return { status: 200,
      code: remove ? "CANDIDATE_REMOVED" : "CANDIDATE_RESTORED",
      changed: true, removed: remove, sendingEnabled: false };
  });
}
