// Workspace-level authorization shared by future tenant-aware endpoints.
// Admin authentication does not implicitly authorize access to partner data.
const CUID = /^c[a-z0-9]{10,40}$/;

export function isWorkspaceId(value) {
  return typeof value === "string" && CUID.test(value);
}

export async function requireWorkspaceMembership(db, { userId, workspaceId }) {
  if (!isWorkspaceId(userId) || !isWorkspaceId(workspaceId)) return null;
  const member = await db.partnerMembership.findUnique({
    where: { partnerId_userId: { partnerId: workspaceId, userId } },
    select: {
      id: true, role: true, revokedAt: true,
      user: { select: { id: true, googleSub: true } },
    },
  });
  if (!member || member.revokedAt || !member.user?.googleSub ||
      member.user.id !== userId) return null;
  return Object.freeze({ workspaceId, userId, membershipId: member.id, role: member.role });
}

export function scopedCandidateWhere(access, extra = {}) {
  if (!access?.workspaceId || !isWorkspaceId(access.workspaceId)) {
    throw new TypeError("Verified workspace access required");
  }
  if ("workspaceId" in extra || "OR" in extra || "AND" in extra || "NOT" in extra) {
    throw new TypeError("Ownership filtering is controlled by the server");
  }
  return Object.freeze({ ...extra, workspaceId: access.workspaceId });
}
