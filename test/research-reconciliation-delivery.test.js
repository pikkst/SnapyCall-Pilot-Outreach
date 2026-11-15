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

import { createHash } from "node:crypto";

function fixtureDb(overrides = {}, reservationIsActive = true) {
  const reservationId = "8a32e765-09b7-41c6-8142-083fc22c0892";
  const item = {
    dedupeKey: createHash("sha256").update("research-stale-v1:" + reservationId)
      .digest("hex"),
    status: "PENDING", attempts: 0, attemptAt: null, leaseUntil: null,
    staleCount: 1, estimatedHeldCents: 50, ...overrides,
  };
  return {
    item,
    researchReconciliationOutbox: {
      async findFirst() {
        return ["PENDING", "FAILED"].includes(item.status) ||
          (item.status === "SENDING" && item.leaseUntil &&
            item.leaseUntil <= fixtureDb.now) ? { ...item } : null;
      },
      async updateMany({ where, data }) {
        if (item.status !== where.status ||
            item.attempts !== where.attempts && where.attempts !== undefined ||
            item.leaseUntil?.getTime() !== where.leaseUntil?.getTime() ||
            item.attemptAt?.getTime() !== where.attemptAt?.getTime()) return { count: 0 };
        Object.assign(item, data);
        if (data.attempts && typeof data.attempts === "object") {
          item.attempts = where.attempts + data.attempts.increment;
        }
        return { count: 1 };
      },
    },
    researchSpendReservation: {
      async findFirst() {
        return reservationIsActive ? { id: reservationId } : null;
      },
    },
  };
}

test("uncertain provider timeout retries with exactly the same idempotency key", async () => {
  const now = new Date("2026-11-15T02:00:00.000Z");
  const db = fixtureDb();
  fixtureDb.now = now;
  let firstKey;
  const failed = await dispatchResearchReconciliationAlert(db, validEnv,
    async (_url, options) => {
      firstKey = options.headers["Idempotency-Key"];
      throw new Error("NETWORK_TIMEOUT");
    }, now);
  assert.equal(failed.state, "failed");
  assert.equal(db.item.status, "FAILED");
  assert.equal(db.item.attempts, 1);
  const retriedAt = new Date(now.getTime() + 60000);
  const retried = await dispatchResearchReconciliationAlert(db, validEnv,
    async (_url, options) => {
      assert.equal(options.headers["Idempotency-Key"], firstKey);
      return { ok: true, json: async () => ({ id: "retry-receipt" }) };
    }, retriedAt);
  assert.equal(retried.state, "sent");
  assert.equal(db.item.attempts, 2);
  assert.equal(db.item.status, "SENT");
  assert.equal(db.item.providerId, "retry-receipt");
});

test("ambiguous delivery older than retry window requires manual review", async () => {
  const now = new Date("2026-11-15T02:00:00.000Z");
  const db = fixtureDb({ status: "FAILED", attempts: 1,
    attemptAt: new Date(now.getTime() - 24 * 60 * 60 * 1000) });
  let called = false;
  const result = await dispatchResearchReconciliationAlert(db, validEnv,
    async () => { called = true; throw new Error("must not send"); }, now);
  assert.equal(result.state, "manual_review");
  assert.equal(db.item.status, "MANUAL_REVIEW");
  assert.equal(called, false);
});

test("reservation settled before delivery skips message and never calls provider", async () => {
  const now = new Date("2026-11-15T02:00:00.000Z");
  const db = fixtureDb({}, false);
  let called = false;
  const result = await dispatchResearchReconciliationAlert(db, validEnv,
    async () => { called = true; }, now);
  assert.equal(result.state, "skipped");
  assert.equal(db.item.status, "SKIPPED");
  assert.equal(called, false);
});
