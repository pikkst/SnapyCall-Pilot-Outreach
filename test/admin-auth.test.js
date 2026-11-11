import test from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { bootstrapAdmin, validateBootstrapPassword, verifyAdmin } from "../server/admin-auth.js";

function database() {
  const credentials = new Map();
  const audits = [];
  const tx = {
    adminCredential: {
      create: async ({ data }) => {
        if (credentials.has(data.id)) {
          const error = new Error("Unique constraint");
          error.code = "P2002";
          throw error;
        }
        credentials.set(data.id, { ...data });
        return data;
      },
    },
    auditEvent: { create: async ({ data }) => { audits.push(data); } },
  };
  return {
    credentials, audits,
    prisma: {
      adminCredential: {
        findUnique: async ({ where }) => credentials.get(where.id) ?? null,
      },
      $transaction: async (callback) => {
        // A transaction rolls back both records on error.
        const savedCredentials = new Map(credentials);
        const priorAuditLength = audits.length;
        try { return await callback(tx); }
        catch (err) {
          credentials.clear();
          for (const [id, value] of savedCredentials) credentials.set(id, value);
          audits.length = priorAuditLength;
          throw err;
        }
      },
    },
  };
}

const env = { ADMIN_EMAIL: "Admin@Example.Test", ADMIN_PASSWORD: "a-long-private-bootstrap-passphrase" };

test("bootstrap creates a bcrypt-backed credential exactly once", async () => {
  const db = database();
  assert.deepEqual(await bootstrapAdmin(db.prisma, env), { created: true });
  const record = db.credentials.get("admin");
  assert.equal(record.email, "admin@example.test");
  assert.notEqual(record.passwordHash, env.ADMIN_PASSWORD);
  assert.match(record.passwordHash, /^\$2[aby]\$12\$/);
  assert.equal(await bcrypt.compare(env.ADMIN_PASSWORD, record.passwordHash), true);
  assert.deepEqual(db.audits.map((event) => event.action), ["admin.bootstrap.completed"]);
  assert.equal(await verifyAdmin(env.ADMIN_EMAIL, env.ADMIN_PASSWORD, db.prisma), true);
  assert.equal(await verifyAdmin(env.ADMIN_EMAIL, "wrong-password", db.prisma), false);
  assert.equal(await verifyAdmin("other@example.test", env.ADMIN_PASSWORD, db.prisma), false);
});

test("restarts do not reset credentials when ADMIN_PASSWORD changes or is removed", async () => {
  const db = database();
  await bootstrapAdmin(db.prisma, env);
  const originalHash = db.credentials.get("admin").passwordHash;
  assert.deepEqual(await bootstrapAdmin(db.prisma, { ...env, ADMIN_PASSWORD: "a-new-bootstrap-password-that-must-not-work" }), { created: false });
  assert.deepEqual(await bootstrapAdmin(db.prisma, { ADMIN_EMAIL: env.ADMIN_EMAIL }), { created: false });
  assert.equal(db.credentials.get("admin").passwordHash, originalHash);
  assert.equal(db.audits.length, 1);
  assert.equal(await verifyAdmin(env.ADMIN_EMAIL, env.ADMIN_PASSWORD, db.prisma), true);
  assert.equal(await verifyAdmin(env.ADMIN_EMAIL, "a-new-bootstrap-password-that-must-not-work", db.prisma), false);
});

test("missing or weak first-time bootstrap password fails closed", async () => {
  const db = database();
  await assert.rejects(() => bootstrapAdmin(db.prisma, { ADMIN_EMAIL: env.ADMIN_EMAIL }), /one-time bootstrap/);
  await assert.rejects(() => bootstrapAdmin(db.prisma, { ADMIN_EMAIL: env.ADMIN_EMAIL, ADMIN_PASSWORD: "short" }), /at least 12/);
  assert.equal(db.credentials.size, 0);
  assert.equal(db.audits.length, 0);
});

test("bcrypt input is bounded by byte length to avoid silent truncation", () => {
  assert.throws(() => validateBootstrapPassword("A".repeat(73)), /72 UTF-8 bytes/);
  assert.throws(() => validateBootstrapPassword("🔒".repeat(20)), /72 UTF-8 bytes/);
});

test("concurrent bootstrap conflict does not replace the winner", async () => {
  const db = database();
  await bootstrapAdmin(db.prisma, env);
  const hash = db.credentials.get("admin").passwordHash;
  // The other instance's initial read races and returns no row.
  const racingPrisma = {
    ...db.prisma,
    adminCredential: { findUnique: async () => null },
  };
  // A real DB unique violation is observed through the transaction.
  // This mock's winning row is returned through a separate follow-up read.
  racingPrisma.adminCredential.findUnique = async () => {
    const count = (racingPrisma._reads ?? 0) + 1;
    racingPrisma._reads = count;
    return count === 1 ? null : db.credentials.get("admin");
  };
  assert.deepEqual(await bootstrapAdmin(racingPrisma, { ...env, ADMIN_PASSWORD: "a-different-strong-password" }), { created: false });
  assert.equal(db.credentials.get("admin").passwordHash, hash);
});
