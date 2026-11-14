import test from "node:test";
import assert from "node:assert/strict";
import { isWorkspaceId, requireWorkspaceMembership,
  scopedCandidateWhere } from "../server/workspace-access.js";

const workspaceId = "cworkspace1234";
const userId = "cpartneruser1234";

test("workspace access requires verified active membership for the exact user and workspace", async () => {
  let queried = 0;
  const db = { partnerMembership: { async findUnique({ where }) {
    queried++;
    assert.deepEqual(where, { partnerId_userId: { partnerId: workspaceId, userId } });
    return { id: "cmembership1234", role: "PARTNER", revokedAt: null,
      user: { id: userId, googleSub: "google-subject" } };
  } } };
  const access = await requireWorkspaceMembership(db, { userId, workspaceId });
  assert.deepEqual(access, { workspaceId, userId,
    membershipId: "cmembership1234", role: "PARTNER" });
  assert.ok(Object.isFrozen(access));
  assert.equal(queried, 1);
});

test("revoked, missing and unbound memberships are never granted access", async () => {
  const record = { id: "cmembership1234", role: "PARTNER",
    revokedAt: null, user: { id: userId, googleSub: "subject" } };
  for (const changed of [null, { ...record, revokedAt: new Date() },
    { ...record, user: { ...record.user, googleSub: null } },
    { ...record, user: { ...record.user, id: "cdifferentuser123" } }]) {
    const db = { partnerMembership: { findUnique: async () => changed } };
    assert.equal(await requireWorkspaceMembership(db, { userId, workspaceId }), null);
  }
});

test("untrusted, missing or malformed workspace IDs fail closed before querying", async () => {
  let count = 0;
  const db = { partnerMembership: { findUnique: async () => { count++; return {}; } } };
  for (const id of ["", "../admin", "null", undefined, null, "c", "cother1234/evil"]) {
    assert.equal(isWorkspaceId(id), false);
    assert.equal(await requireWorkspaceMembership(db, { userId, workspaceId: id }), null);
  }
  assert.equal(count, 0);
});

test("tenant filter cannot be replaced by user supplied conditions", () => {
  const access = { workspaceId };
  assert.deepEqual(scopedCandidateWhere(access, { id: "ccandidate1234" }),
    { id: "ccandidate1234", workspaceId });
  assert.throws(() => scopedCandidateWhere(null));
  assert.throws(() => scopedCandidateWhere(access, { workspaceId: "cotherworkspace123" }));
  assert.throws(() => scopedCandidateWhere(access, { OR: [{ workspaceId: null }] }));
});
