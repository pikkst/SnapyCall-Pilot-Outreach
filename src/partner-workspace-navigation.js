// The browser may simplify navigation only after a verified partner session
// reports exactly one authorized workspace. Server membership checks remain
// the source of truth for every data request.
export function singleAuthorizedWorkspaceId(session) {
  if (!session?.authenticated || typeof session.userId !== "string" ||
      !Array.isArray(session.partners) || session.partners.length !== 1) {
    return null;
  }
  const id = session.partners[0]?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}
