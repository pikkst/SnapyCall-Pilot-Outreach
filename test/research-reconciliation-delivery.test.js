import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  reconciliationEmailConfig, makeReconciliationEmail, sendReconciliationEmail,
  dispatchResearchReconciliationAlert,
} from "../server/research-reconciliation-delivery.js";

const validEnv = {
  RESEARCH_ALERT_DELIVERY_ENABLED: "true",
  RESEND_API_KEY: "test-provider-key",
  RESEARCH_ALERT_FROM: "SnapyCall Alerts <alerts@example.test>",
  RESEARCH_ALERT_TO: "operator@example.test",
};
const incident = {
  dedupeKey: "a".repeat(64), staleCount: 2, estimatedHeldCents: 125,
};

test("dispatcher is disabled unless explicitly enabled with separate operator mailbox", async () => {
  assert.equal(reconciliationEmailConfig({}), null);
  assert.deepEqual(await dispatchResearchReconciliationAlert(null, {}),
    { state: "disabled" });
  for (const env of [
    { ...validEnv, RESEARCH_ALERT_TO: "" },
    { ...validEnv, RESEARCH_ALERT_FROM: "Bad\r\nInjected: yes" },
    { ...validEnv, RESEARCH_ALERT_TO: "a@example.test,b@example.test" },
    { ...validEnv, RESEND_API_KEY: "" },
  ]) assert.throws(() => reconciliationEmailConfig(env));
  assert.equal(reconciliationEmailConfig(validEnv).to, "operator@example.test");
});

test("alert email is sanitized and carries no raw tenant or reservation data", () => {
  const payload = makeReconciliationEmail(reconciliationEmailConfig(validEnv), incident);
  assert.equal(payload.to[0], validEnv.RESEARCH_ALERT_TO);
  assert.match(payload.text, /USD 1.25/);
  assert.match(payload.text, /NOT a provider invoice/);
  assert.ok(!payload.text.includes(incident.dedupeKey));
  assert.equal(payload.subject, "SnapyCall: manual research charge review required");
});

test("Resend accepts one fixed per-incident key and rejects unknown receipts", async () => {
  let calls = 0;
  const fetcher = async (url, options) => {
    calls++;
    assert.equal(url, "https://api.resend.com/emails");
    assert.equal(options.headers["Idempotency-Key"],
      "snapycall-research-reconcile-" + incident.dedupeKey);
    assert.equal(JSON.parse(options.body).to[0], validEnv.RESEARCH_ALERT_TO);
    return { ok: true, json: async () => ({ id: "email-provider-123" }) };
  };
  const config = reconciliationEmailConfig(validEnv);
  assert.equal(await sendReconciliationEmail(config, incident, fetcher),
    "email-provider-123");
  assert.equal(calls, 1);
  await assert.rejects(() => sendReconciliationEmail(config, incident,
    async () => ({ ok: true, json: async () => ({}) })), /INVALID_RESPONSE/);
});

test("operator delivery CLI never calls a provider when the flag is absent", () => {
  const { DATABASE_URL: _db, RESEARCH_ALERT_DELIVERY_ENABLED: _flag, ...env } = process.env;
  const result = spawnSync(process.execPath,
    ["scripts/research-reconciliation-deliver.mjs"], {
      env, encoding: "utf8", timeout: 15000,
    });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { status: "disabled" });
});
