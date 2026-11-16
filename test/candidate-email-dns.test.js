import test from "node:test";
import assert from "node:assert/strict";
import { inspectAndPersistCandidateDns, visibleCandidateDnsSnapshot
} from "../server/candidate-email-dns.js";

const scope = {
  workspaceId: "cmabcdefghijklmnopqrstu",
  ownerId: "cmabcdefghijklmnopqrstv",
  candidateId: "cmabcdefghijklmnopqrstw",
};
const NOW = new Date("2026-11-16T16:00:00.000Z");
const dns = { status: "UNKNOWN", reason: "MX_PRESENT", domainAcceptsMail: true };

function fixture({ beforeEmail = "ada@example.org", afterEmail = beforeEmail,
  revoked = false, missing = false } = {}) {
  const log = [];
  let saved;
  const tx = {
    $queryRaw: async strings => {
      const sql = strings.join("?");
      if (sql.includes('FROM "PartnerMembership"')) {
        log.push("membership-locked");
        return revoked ? [{ revokedAt: NOW }] : [{ revokedAt: null }];
      }
      if (sql.includes('FROM "Candidate"')) {
        log.push("candidate-locked");
        return missing ? [] : [{ id: scope.candidateId, email: afterEmail }];
      }
      throw Error("Unexpected SQL");
    },
    candidateEmailVerification: {
      upsert: async input => {
        saved = input.create;
        log.push("saved");
        assert.equal(input.where.candidateId, scope.candidateId);
      },
    },
    auditEvent: { create: async input => {
      log.push("audited");
      assert.equal(input.data.actorId, scope.ownerId);
      assert.doesNotMatch(JSON.stringify(input.data), /ada@example.org/);
    } },
  };
  return {
    log, getSaved: () => saved,
    db: {
      candidate: { findFirst: async () =>
        missing ? null : { id: scope.candidateId, email: beforeEmail } },
      $transaction: fn => fn(tx),
    },
  };
}

test("DNS observation persists only under current workspace membership and exact address", async () => {
  const v = fixture();
  const out = await inspectAndPersistCandidateDns(v.db, scope, {
    inspect: async email => { assert.equal(email, "ada@example.org"); return dns; },
    now: () => NOW,
  });
  assert.equal(out.status, 200);
  assert.equal(out.verification.status, "UNKNOWN");
  assert.equal(out.verification.mailboxVerified, false);
  assert.equal(out.onboardingEligible, false);
  assert.equal(out.usableAsContact, false);
  assert.deepEqual(v.log, ["membership-locked", "candidate-locked", "saved", "audited"]);
  assert.equal(v.getSaved().emailNormalized, "ada@example.org");
  assert.equal(v.getSaved().expiresAt.getTime() - NOW.getTime(), 604800000);
});

test("changed email after the DNS lookup forbids saving a stale result", async () => {
  const v = fixture({ afterEmail: "new@example.org" });
  const out = await inspectAndPersistCandidateDns(v.db, scope, {
    inspect: async () => dns, now: () => NOW,
  });
  assert.equal(out.status, 409);
  assert.equal(out.code, "EMAIL_CHANGED_RECHECK_REQUIRED");
  assert.equal(v.getSaved(), undefined);
  assert.deepEqual(v.log, ["membership-locked", "candidate-locked"]);
});

test("revoked membership cannot persist DNS evidence", async () => {
  const v = fixture({ revoked: true });
  const out = await inspectAndPersistCandidateDns(v.db, scope, {
    inspect: async () => dns, now: () => NOW,
  });
  assert.equal(out.status, 403);
  assert.equal(v.getSaved(), undefined);
  assert.deepEqual(v.log, ["membership-locked"]);
});

test("unrecognized VALID-looking input cannot become DNS mailbox proof", async () => {
  const v = fixture();
  await assert.rejects(() => inspectAndPersistCandidateDns(v.db, scope, {
    inspect: async () => ({ ...dns, status: "VALID" }), now: () => NOW,
  }), TypeError);
  assert.equal(v.getSaved(), undefined);
});

test("DNS snapshot invalidates after email change, expiry and schema mismatch", () => {
  const row = { email: "ada@example.org" };
  const check = {
    emailNormalized: "ada@example.org", checkType: "DNS_MX",
    status: "UNKNOWN", reason: "MX_PRESENT", domainAcceptsMail: true,
    checkedAt: NOW, expiresAt: new Date(NOW.getTime() + 5000),
  };
  assert.equal(visibleCandidateDnsSnapshot(row, check, NOW).mailboxVerified, false);
  assert.equal(visibleCandidateDnsSnapshot(row, check, NOW).onboardingEligible, false);
  assert.equal(visibleCandidateDnsSnapshot({ email: "new@example.org" }, check, NOW), null);
  assert.equal(visibleCandidateDnsSnapshot(row, check,
    new Date(NOW.getTime() + 5000)), null);
  assert.equal(visibleCandidateDnsSnapshot(row, { ...check, checkType: "PROVIDER" }, NOW), null);
  assert.equal(visibleCandidateDnsSnapshot(row, { ...check, status: "VALID" }, NOW), null);
});

test("missing candidate is not inspected and never persisted", async () => {
  const v = fixture({ missing: true });
  const result = await inspectAndPersistCandidateDns(v.db, scope, {
    inspect: () => { throw Error("Should not inspect"); },
  });
  assert.deepEqual(result, { status: 404, code: "CANDIDATE_NOT_FOUND" });
});
