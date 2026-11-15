import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("monitoring command is safe-by-default and never needs database credentials when disabled", () => {
  const { RESEARCH_ALERT_CHECK_ENABLED: _enabled, DATABASE_URL: _db, ...env } = process.env;
  const result = spawnSync(process.execPath,
    ["scripts/research-reconciliation-check.mjs"], {
      env, encoding: "utf8", timeout: 15000,
    });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { status: "disabled" });
});

test("enabled monitoring without a database fails closed", () => {
  const { DATABASE_URL: _db, ...env } = process.env;
  const result = spawnSync(process.execPath,
    ["scripts/research-reconciliation-check.mjs"], {
      env: { ...env, RESEARCH_ALERT_CHECK_ENABLED: "true" },
      encoding: "utf8", timeout: 15000,
    });
  assert.equal(result.status, 1);
  assert.equal(result.stdout.trim(), "");
  assert.match(result.stderr, /requires an explicitly configured database/);
});
