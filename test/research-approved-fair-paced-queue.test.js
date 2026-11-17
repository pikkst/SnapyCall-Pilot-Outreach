import test from "node:test";
import assert from "node:assert/strict";
import { tickApprovedCampaignRun } from "../server/research-approved-runner.js";
import { ResearchPacingRequired } from "../server/research-quota.js";

const id = "cmabcdefghijklmnopqrstu";
const scope = { campaignId: id, workspaceId: id, ownerId: id };
const encryptionKey = "test-only-server-encryption-key";

test("approved queue rotates using persisted last activity, not the first approval", async () => {
  let selection;
  const db = { researchCampaignRun: { findFirst: async args => {
    selection = args;
    return scope;
  } } };
  const result = await tickApprovedCampaignRun(db, {
    encryptionKey,
    runTask: async () => ({ status: "COMPLETED", attempted: true }),
    finish: async () => ({ code: "RUNNING", lastCode: null }),
    pause: async () => { throw Error("must not pause"); },
  });
  assert.equal(result.status, "COMPLETED");
  assert.deepEqual(selection.orderBy,
    [{ updatedAt: "asc" }, { id: "asc" }]);
  assert.deepEqual(selection.where.status.in, ["APPROVED", "RUNNING"]);
});

test("DB-paced task stays pending without a paid retry, run pause or lost approval", async () => {
  let calls = 0;
  let finished;
  const db = { researchCampaignRun: { findFirst: async () => scope } };
  const result = await tickApprovedCampaignRun(db, {
    encryptionKey,
    runTask: async () => { calls++; throw new ResearchPacingRequired(22_000); },
    finish: async (_db, args) => {
      finished = args;
      return { code: "RUNNING", lastCode: "WAITING_RATE_LIMIT" };
    },
    pause: async () => { throw Error("pacing must not pause"); },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "WAITING");
  assert.equal(result.code, "WAITING_RATE_LIMIT");
  assert.equal(result.retryAfterSeconds, 22);
  assert.equal(finished.result.status, "RATE_LIMIT_WAIT");
  assert.equal(finished.result.attempted, false);
  assert.deepEqual({ ...finished, result: undefined }, { ...scope, result: undefined });
});

test("a potentially billable unknown exception still pauses instead of replaying", async () => {
  let paused;
  const db = { researchCampaignRun: { findFirst: async () => scope } };
  const result = await tickApprovedCampaignRun(db, {
    encryptionKey,
    runTask: async () => { throw Error("Unknown provider transport outcome"); },
    finish: async () => { throw Error("No success completion"); },
    pause: async (_db, args) => { paused = args; },
  });
  assert.equal(result.status, "PAUSED");
  assert.equal(result.code, "RUN_EXECUTION_UNCERTAIN");
  assert.equal(paused.code, "RUN_EXECUTION_UNCERTAIN");
});

test("idle queue does not issue any research call", async () => {
  const db = { researchCampaignRun: { findFirst: async () => null } };
  assert.deepEqual(await tickApprovedCampaignRun(db, {
    encryptionKey, runTask: async () => { throw Error("unexpected"); },
  }), { status: "IDLE" });
});
