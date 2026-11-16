import test from "node:test";
import assert from "node:assert/strict";
import {
  persistCandidateMailboxEvidence, visibleCandidateMailboxEvidence,
} from "../server/candidate-mailbox-evidence.js";

const scope = {
  workspaceId: "cmabcdefghijklmnopqrstu",
  ownerId: "cmabcdefghijklmnopqrstv",
  candidateId: "cmabcdefghijklmnopqrstw",
};
const date = new Date("2026-11-16T16:13:00Z");
const clock = { now: () => new Date("2026-11-16T16:14:00Z") };
const evidence = {
  emailNormalized: "ada@example.org", provider: "ZEROBOUNCE",
  adapterVersion: "v1", status: "VALID", reason: "PROVIDER_MAILBOX_REACHABLE",
  billableAttemptUncertain: false, checkedAt: date,
};

function makeDb({ beforeEmail = "ada@example.org", afterEmail = beforeEmail,
  revoked = false, existing = null } = {}) {
  const calls = [];
  let saved;
  const tx = {
    $queryRaw: async strings => {
      if (strings.join("?").includes('FROM "PartnerMembership"')) {
        calls.push("membership");
        return revoked ? [{ revokedAt: date }] : [{ revokedAt: null }];
      }
      calls.push("candidate");
      return [{ id: scope.candidateId, email: afterEmail }];
    },
    candidateMailboxVerification: {
      findUnique: async () => existing,
      upsert: async input => { saved = input.create; calls.push("saved"); },
    },
    auditEvent: { create: async input => {
      calls.push("audited");
      assert.doesNotMatch(JSON.stringify(input.data), /ada@example.org/);
    } },
  };
  return {
    calls, getSaved: () => saved,
    db: { $transaction: fn => fn(tx) },
  };
}

test("stores only candidate- and email-matched technical classification", async () => {
  const t = makeDb();
  const result = await persistCandidateMailboxEvidence(t.db, scope, evidence, clock);
  assert.equal(result.status, 200);
  assert.equal(result.verificationStatus, "VALID");
  assert.equal(result.personEmailLinked, false);
  assert.equal(result.onboardingEligible, false);
  assert.equal(result.sendingEnabled, false);
  assert.deepEqual(t.calls, ["membership", "candidate", "saved", "audited"]);
  assert.equal(t.getSaved().emailNormalized, "ada@example.org");
  assert.equal(t.getSaved().provider, "ZEROBOUNCE");
  assert.equal(t.getSaved().expiresAt.getTime() - date.getTime(), 604800000);
});

test("revoked membership or changed email cannot write vendor evidence", async () => {
  for (const params of [
    { revoked: true }, { afterEmail: "morgan@example.org" },
  ]) {
    const t = makeDb(params);
    const result = await persistCandidateMailboxEvidence(t.db, scope,
      evidence, clock);
    assert.equal(result.status, params.revoked ? 403 : 409);
    assert.equal(t.getSaved(), undefined);
    assert.ok(!t.calls.includes("saved"));
  }
});

test("ambiguous charged results cannot masquerade as confirmed", async () => {
  const t = makeDb();
  await assert.rejects(() => persistCandidateMailboxEvidence(t.db, scope,
    { ...evidence, billableAttemptUncertain: true }, clock), TypeError);
  assert.equal(t.calls.length, 0);
});

test("older vendor replies cannot overwrite newer verification state", async () => {
  const t = makeDb({ existing: {
    checkedAt: new Date(date.getTime() + 1000),
  } });
  const result = await persistCandidateMailboxEvidence(t.db, scope,
    evidence, clock);
  assert.equal(result.code, "OLDER_VERIFICATION_REJECTED");
  assert.equal(t.getSaved(), undefined);
});

test("duplicate evidence is idempotent; a conflict cannot silently replace it", async () => {
  const t = makeDb({ existing: {
    ...evidence, emailNormalized: "ada@example.org",
  } });
  let result = await persistCandidateMailboxEvidence(t.db, scope,
    evidence, clock);
  assert.equal(result.code, "MAILBOX_VERIFICATION_UNCHANGED");
  assert.ok(!t.calls.includes("audited"));
  const different = { ...evidence, status: "INVALID",
    reason: "PROVIDER_MAILBOX_UNREACHABLE" };
  result = await persistCandidateMailboxEvidence(t.db, scope, different, clock);
  assert.equal(result.code, "VERIFICATION_CONFLICT");
  assert.equal(t.getSaved(), undefined);
});

test("visibility requires matching email, freshness and certain billing", () => {
  const snapshot = {
    ...evidence,
    checkedAt: date, expiresAt: new Date(date.getTime() + 604800000),
  };
  const visible = visibleCandidateMailboxEvidence({ email: "ada@example.org" },
    snapshot, clock.now());
  assert.equal(visible.providerSaysDeliverable, true);
  assert.equal(visible.onboardingEligible, false);
  assert.equal(visible.usableAsContact, false);
  assert.equal(visibleCandidateMailboxEvidence({ email: "new@example.org" },
    snapshot, clock.now()), null);
  assert.equal(visibleCandidateMailboxEvidence({ email: "ada@example.org" },
    { ...snapshot, billableAttemptUncertain: true }, clock.now()), null);
  assert.equal(visibleCandidateMailboxEvidence({ email: "ada@example.org" },
    snapshot, new Date(date.getTime() + 604800000)), null);
});
