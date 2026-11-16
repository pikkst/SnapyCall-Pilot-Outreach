import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMailboxProviderEvidence, verifyMailboxWithApprovedAdapter,
  MailboxVerificationContractError,
} from "../server/email-mailbox-provider.js";

const email = "ada.mentor@example.org";
const provider = "APPROVED_TEST";
const adapterVersion = "v1";
const payload = {
  email, provider, adapterVersion, verdict: "DELIVERABLE",
  evidenceType: "MAILBOX_REACHABILITY",
  catchAll: false, disposable: false, roleAccount: false,
};

test("the adapter contract accepts only exact email and provider identities", () => {
  const result = normalizeMailboxProviderEvidence(payload, {
    email: "ADA.MENTOR@example.org", provider, adapterVersion,
  });
  assert.equal(result.status, "VALID");
  assert.equal(result.emailNormalized, email);
  assert.equal(result.reason, "PROVIDER_MAILBOX_REACHABLE");
  for (const changes of [
    { email: "morgan@example.org" },
    { provider: "UNTRUSTED" },
    { adapterVersion: "v2" },
  ]) {
    assert.throws(() => normalizeMailboxProviderEvidence({
      ...payload, ...changes,
    }, { email, provider, adapterVersion }), MailboxVerificationContractError);
  }
});

test("catch-all, disposable and role accounts fail closed even if provider says deliverable", () => {
  for (const flag of ["catchAll", "disposable", "roleAccount"]) {
    const result = normalizeMailboxProviderEvidence({
      ...payload, [flag]: true,
    }, { email, provider, adapterVersion });
    assert.equal(result.status, "RISKY");
    assert.equal(result.reason, "AMBIGUOUS_MAILBOX");
  }
  const withoutReachability = normalizeMailboxProviderEvidence({
    ...payload, evidenceType: "PROVIDER_ACCEPTANCE",
  }, { email, provider, adapterVersion });
  assert.equal(withoutReachability.status, "RISKY");
});

test("unknown, invalid and malformed classifications never imply a valid mailbox", () => {
  for (const [verdict, status] of [
    ["UNKNOWN", "UNKNOWN"], ["RISKY", "RISKY"],
    ["UNDELIVERABLE", "INVALID"],
  ]) {
    assert.equal(normalizeMailboxProviderEvidence({
      ...payload, verdict,
    }, { email, provider, adapterVersion }).status, status);
  }
  assert.throws(() => normalizeMailboxProviderEvidence({
    ...payload, verdict: "SUCCESS",
  }, { email, provider, adapterVersion }), MailboxVerificationContractError);
  assert.throws(() => normalizeMailboxProviderEvidence({
    ...payload, catchAll: undefined,
  }, { email, provider, adapterVersion }), MailboxVerificationContractError);
});

test("provider execution requires explicit opt-in; no call when disabled", async () => {
  let called = false;
  const adapter = { provider, version: adapterVersion,
    verify: async () => { called = true; return payload; } };
  await assert.rejects(() => verifyMailboxWithApprovedAdapter(email, {
    adapter, approved: false,
  }), e => e.code === "PROVIDER_DISABLED");
  assert.equal(called, false);
});

test("approved adapter produces bounded, sanitized evidence without source payload", async () => {
  const at = new Date("2026-11-16T16:13:00.000Z");
  const result = await verifyMailboxWithApprovedAdapter(email, {
    approved: true, now: () => at,
    adapter: { provider, version: adapterVersion,
      verify: async (input, { signal }) => {
        assert.equal(input, email);
        assert.equal(signal.aborted, false);
        return { ...payload, secret: "never exposed" };
      } },
  });
  assert.equal(result.status, "VALID");
  assert.equal(result.checkedAt, at);
  assert.equal(result.billableAttemptUncertain, false);
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test("timeouts and uncertain provider failures never auto-retry", async () => {
  let calls = 0;
  const result = await verifyMailboxWithApprovedAdapter(email, {
    approved: true, timeoutMs: 100,
    adapter: { provider, version: adapterVersion, verify: () => {
      calls++;
      return new Promise(() => {});
    } },
  });
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.reason, "PROVIDER_UNAVAILABLE");
  assert.equal(result.billableAttemptUncertain, true);
  assert.equal(calls, 1);
});

test("provider transport errors remain sanitized", async () => {
  const result = await verifyMailboxWithApprovedAdapter(email, {
    approved: true,
    adapter: { provider, version: adapterVersion,
      verify: async () => { throw new Error("API_KEY_SECRET"); } },
  });
  assert.equal(result.status, "UNKNOWN");
  assert.doesNotMatch(JSON.stringify(result), /API_KEY_SECRET/);
});
