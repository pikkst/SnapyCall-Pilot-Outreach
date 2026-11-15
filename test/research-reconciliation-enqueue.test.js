import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("enqueue CLI is disabled by default without DB side effects", () => {
  const { RESEARCH_ALERT_ENQUEUE_ENABLED: _enabled, DATABASE_URL: _db, ...env } = process.env;
  const result = spawnSync(process.execPath, ["scripts/research-reconciliation-enqueue.mjs"], {
    env, encoding: "utf8", timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { status: "disabled" });
});
test("enqueue CLI refuses enabled execution without explicit DB config", () => {
  const { DATABASE_URL: _db, ...env } = process.env;
  const result = spawnSync(process.execPath, ["scripts/research-reconciliation-enqueue.mjs"], {
    env: { ...env, RESEARCH_ALERT_ENQUEUE_ENABLED: "true" },
    encoding: "utf8", timeout: 15000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /requires an explicitly configured database/);
});
