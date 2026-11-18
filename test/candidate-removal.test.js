import test from "node:test";
import assert from "node:assert/strict";
import { changeCandidateRemoval } from "../server/candidate-removal.js";
import { outreachDecision, qualificationDecision } from "../src/domain.js";
import { projectCandidateContactReadiness }
  from "../server/candidate-contact-readiness.js";

const scope = {
  candidateId: "cmabcdefghijklmnopqrstu",
  workspaceId: "cmabcdefghijklmnopqrstv",
  actorId: "cmabcdefghijklmnopqrstw",
};
const now = new Date("2026-11-18T17:00:00.000Z");

function fixture({ membership = true, ownsCandidate = true,
  removedAt = null, noCandidate = false } = {}) {
  const events = [];
  const row = { id: scope.candidateId,
    removedAt, removedBy: removedAt ? "previous-owner" : null };
  const db = { $transaction: async fn => fn({
    $queryRaw: async parts => {
      const sql = parts.join("?");
      if (sql.includes('FROM "PartnerMembership"'))
        return membership ? [{ revokedAt: null }] : [];
      if (sql.includes('FROM "Candidate"')) {
        return ownsCandidate && !noCandidate ? [row] : [];
      }
      throw new Error("Unexpected lock query");
    },
    candidate: {
      updateMany: async ({ where, data }) => {
        assert.equal(where.id, scope.candidateId);
        assert.equal(where.workspaceId, scope.workspaceId);
        events.push("candidate-update");
        if (where.removedAt === null && row.removedAt !== null) return { count: 0 };
        if (where.removedAt?.not === null && row.removedAt === null) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    auditEvent: { create: async ({ data }) => {
      events.push(data.action);
      assert.equal(data.actorId, scope.actorId);
      assert.equal(data.entityId, scope.candidateId);
      assert.equal(data.metadata.permanentErasure, false);
      assert.equal(data.metadata.mailSendingAuthorized, false);
    } },
  }) };
  return { db, row, events };
}

test("remove hides contact while preserving all existing relationship references", async () => {
  const state = fixture();
  const result = await changeCandidateRemoval(state.db, {
    ...scope, remove: true,
  }, { now });
  assert.equal(result.code, "CANDIDATE_REMOVED");
  assert.equal(result.removed, true);
  assert.equal(result.sendingEnabled, false);
  assert.deepEqual(state.events, ["candidate-update", "candidate.removed"]);
  assert.equal(state.row.removedAt, now);
  assert.equal(state.row.removedBy, scope.actorId);
});

test("repeating remove is idempotent, with no extra audit or mutation", async () => {
  const state = fixture({ removedAt: now });
  const result = await changeCandidateRemoval(state.db, {
    ...scope, remove: true,
  }, { now });
  assert.equal(result.code, "CANDIDATE_ALREADY_REMOVED");
  assert.equal(result.changed, false);
  assert.deepEqual(state.events, []);
});

test("restore returns contact without creating a second Candidate", async () => {
  const state = fixture({ removedAt: now });
  const result = await changeCandidateRemoval(state.db, {
    ...scope, remove: false,
  }, { now });
  assert.equal(result.code, "CANDIDATE_RESTORED");
  assert.equal(result.removed, false);
  assert.equal(state.row.removedAt, null);
  assert.equal(state.row.removedBy, null);
  assert.deepEqual(state.events, ["candidate-update", "candidate.restored"]);
  const again = await changeCandidateRemoval(state.db, {
    ...scope, remove: false,
  }, { now });
  assert.equal(again.code, "CANDIDATE_ALREADY_ACTIVE");
  assert.equal(state.events.length, 2);
});

test("revoked workspace access and wrong workspace scope cannot remove contact", async () => {
  for (const options of [{ membership: false },
    { ownsCandidate: false }, { noCandidate: true }]) {
    const state = fixture(options);
    const result = await changeCandidateRemoval(state.db, {
      ...scope, remove: true,
    }, { now });
    assert.equal(result.code, !options.membership &&
      options.membership === false ? "WORKSPACE_ACCESS_REVOKED" :
      "CANDIDATE_NOT_FOUND");
    assert.deepEqual(state.events, []);
  }
});

test("admin legacy rows require explicit admin identity and null scope", async () => {
  const legacy = { candidateId: scope.candidateId,
    workspaceId: null, actorId: "admin", remove: true };
  const events = [];
  const db = { $transaction: async fn => fn({
    $queryRaw: async parts => parts.join("?").includes('FROM "Candidate"')
      ? [{ id: scope.candidateId, removedAt: null }] : [],
    candidate: { updateMany: async ({ where }) => {
      assert.equal(where.workspaceId, null);
      events.push("removed"); return { count: 1 };
    } },
    auditEvent: { create: async () => events.push("audit") },
  }) };
  const result = await changeCandidateRemoval(db, legacy, { now });
  assert.equal(result.code, "CANDIDATE_REMOVED");
  assert.deepEqual(events, ["removed", "audit"]);
  await assert.rejects(() => changeCandidateRemoval(db, {
    ...legacy, actorId: scope.actorId,
  }, { now }), TypeError);
});

test("removed contacts cannot be qualification-ready or drafted even with old evidence", () => {
  const candidate = {
    id: scope.candidateId, workspaceId: scope.workspaceId,
    name: "Ada Lovelace", category: "AI_AUTOMATION",
    sourceUrl: "https://example.org/ada",
    email: "ada@example.org", legalBasis: "reviewed",
    contactReviewed: true, onlineEnglish: true,
    suppressed: false, profileReviewed: true,
    removedAt: now,
  };
  const directEmailObservation = {
    workspaceId: scope.workspaceId, candidateId: candidate.id,
    status: "PERSON_EMAIL_REVIEWED", personName: "Ada Lovelace",
    emailNormalized: candidate.email, profileUrl: candidate.sourceUrl,
    evidenceDigest: "a".repeat(64), inspectedAt: now,
    reviewedAt: now, reviewedBy: scope.actorId,
  };
  assert.equal(qualificationDecision(candidate).qualified, false);
  assert.deepEqual(qualificationDecision(candidate).blockers,
    ["candidate_removed"]);
  assert.equal(outreachDecision(candidate).canDraft, false);
  const result = projectCandidateContactReadiness(candidate, {
    directEmailObservation,
  }, now);
  assert.equal(result.outreach.canDraft, false);
  assert.equal(result.contactVerification.usableAsContact, false);
  assert.equal(result.contactVerification.sendingEnabled, false);
});
