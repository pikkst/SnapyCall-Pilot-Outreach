import test from "node:test";
import assert from "node:assert/strict";
import { mapZeroBounceResult, createZeroBounceEuAdapter
} from "../server/email-zerobounce-adapter.js";
import { verifyMailboxWithApprovedAdapter
} from "../server/email-mailbox-provider.js";

const address = "ada@example.org";
const valid = { address, status: "valid", sub_status: "",
  catchall_domain: false };

test("confirmed vendor valid maps to bounded contract without identity claims", () => {
  const result = mapZeroBounceResult(valid, address);
  assert.deepEqual(result, {
    provider: "ZEROBOUNCE", adapterVersion: "v1",
    email: address, verdict: "DELIVERABLE",
    evidenceType: "MAILBOX_REACHABILITY", catchAll: false,
    disposable: false, roleAccount: false,
  });
});

test("unknown catch-all domain never becomes deliverable", () => {
  for (const body of [
    { ...valid, catchall_domain: null },
    { ...valid, catchall_domain: undefined },
    { ...valid, catchall_domain: true },
    { ...valid, sub_status: "accept_all" },
    { ...valid, sub_status: "role_based" },
    { ...valid, sub_status: "disposable" },
    { ...valid, sub_status: "ai_agent_mailbox" },
    { ...valid, status: "catch-all" },
    { ...valid, status: "spamtrap" },
    { ...valid, status: "do_not_mail" },
  ]) {
    const result = mapZeroBounceResult(body, address);
    assert.notEqual(result.verdict, "DELIVERABLE", JSON.stringify(body));
  }
});

test("invalid, unknown and wrong-person responses are never trusted", () => {
  assert.equal(mapZeroBounceResult({ ...valid, status: "invalid" }, address).verdict,
    "UNDELIVERABLE");
  assert.equal(mapZeroBounceResult({ ...valid, status: "unknown" }, address).verdict,
    "UNKNOWN");
  assert.throws(() => mapZeroBounceResult({
    ...valid, address: "morgan@example.org",
  }, address), TypeError);
  assert.throws(() => mapZeroBounceResult({
    error: "Invalid key",
  }, address), TypeError);
});

test("EU adapter sends exactly one POST with body credentials and no key in URL", async () => {
  const calls = [];
  const adapter = createZeroBounceEuAdapter({
    apiKey: "test-private-key",
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, text: async () => JSON.stringify(valid) };
    },
  });
  const output = await verifyMailboxWithApprovedAdapter(address, {
    approved: true, adapter, timeoutMs: 500,
  });
  assert.equal(output.status, "VALID");
  assert.equal(output.billableAttemptUncertain, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api-eu.zerobounce.net/v2/validate");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.signal.aborted, false);
  assert.equal(new URLSearchParams(calls[0].options.body).get("email"), address);
  assert.equal(new URLSearchParams(calls[0].options.body).get("api_key"),
    "test-private-key");
  assert.doesNotMatch(calls[0].url, /test-private-key|ada@/);
  assert.doesNotMatch(JSON.stringify(output), /test-private-key/);
});

test("provider 249 and invalid JSON become sanitized uncertain result", async () => {
  for (const mock of [
    { ok: false, text: async () => JSON.stringify({ message: "slow" }) },
    { ok: true, text: async () => "<invalid>" },
    { ok: true, text: async () => JSON.stringify({
      address: "unrelated@example.org", status: "valid",
    }) },
  ]) {
    const result = await verifyMailboxWithApprovedAdapter(address, {
      approved: true,
      adapter: createZeroBounceEuAdapter({
        apiKey: "test-private-key", fetchFn: async () => mock,
      }),
    });
    assert.equal(result.status, "UNKNOWN");
    assert.equal(result.billableAttemptUncertain, true);
    assert.doesNotMatch(JSON.stringify(result), /unrelated|slow|<invalid>/);
  }
});
