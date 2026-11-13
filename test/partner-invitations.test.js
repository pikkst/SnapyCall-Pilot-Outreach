import test from "node:test";
import assert from "node:assert/strict";
import { invitationEmailConfig, createInvitationEmail,
  sendInvitationEmail, publicInvitationStatus, resetInvitationAttempt } from "../server/partner-invitations.js";

const env = {
  RESEND_API_KEY: "test-provider-key",
  PARTNER_INVITE_FROM: "SnapyCall <invites@example.test>",
  GOOGLE_REDIRECT_URI: "https://staging.example.org/api/auth/google/callback",
};
const member = {
  id: "cmw123456789012345",
  inviteAttempt: 0,
  user: { emailNormalized: "partner@example.org" },
  partner: { name: "Workspace <research>" },
};

test("partner invitations cannot send without configured sender and exact HTTPS login callback", () => {
  assert.equal(invitationEmailConfig({}), null);
  assert.deepEqual(invitationEmailConfig(env), {
    apiKey: env.RESEND_API_KEY,
    from: env.PARTNER_INVITE_FROM,
    loginUrl: "https://staging.example.org/",
  });
  assert.throws(() => invitationEmailConfig({
    ...env, GOOGLE_REDIRECT_URI: "http://staging.example.org/api/auth/google/callback",
  }));
  assert.throws(() => invitationEmailConfig({ ...env, PARTNER_INVITE_FROM: "not-email" }));
});

test("invitation content is bound to the invited account and HTML escaped", () => {
  const message = createInvitationEmail(invitationEmailConfig(env), {
    email: "partner@example.org", workspace: "Workspace <research> & friends",
  });
  assert.deepEqual(message.to, ["partner@example.org"]);
  assert.match(message.text, /Workspace <research> & friends/);
  assert.match(message.html, /Workspace &lt;research&gt; &amp; friends/);
  assert.doesNotMatch(message.html, /<research>/);
  assert.match(message.html, /https:\/\/staging.example.org\//);
});

test("transactional Resend send uses per-attempt idempotency and keeps credentials server-side", async () => {
  let requests = 0;
  const send = async (url, options) => {
    requests++;
    assert.equal(url, "https://api.resend.com/emails");
    assert.equal(options.headers.authorization, "Bearer test-provider-key");
    assert.equal(options.headers["Idempotency-Key"], "snapycall-invite-" + member.id + "-0");
    const payload = JSON.parse(options.body);
    assert.equal(payload.to[0], "partner@example.org");
    assert.equal(payload.from, env.PARTNER_INVITE_FROM);
    assert.equal(JSON.stringify(payload).includes(env.RESEND_API_KEY), false);
    return { ok: true, json: async () => ({ id: "provider-message-id" }) };
  };
  assert.equal(await sendInvitationEmail(invitationEmailConfig(env), member, send), "provider-message-id");
  assert.equal(requests, 1);
  await assert.rejects(() => sendInvitationEmail(invitationEmailConfig(env), member,
    async () => ({ ok: false, status: 429 })));
});

test("acceptance and revocation override provider delivery state", () => {
  assert.equal(publicInvitationStatus({ inviteStatus: "SENT", revokedAt: null, acceptedAt: null }), "SENT");
  assert.equal(publicInvitationStatus({ inviteStatus: "SENT", revokedAt: null, acceptedAt: new Date() }), "ACCEPTED");
  assert.equal(publicInvitationStatus({ inviteStatus: "SENT", revokedAt: new Date(), acceptedAt: null }), "REVOKED");
});

test("concurrent lease renewal prevents stale newAttempt from changing idempotency key", async () => {
  const now = new Date("2026-11-13T19:00:00.000Z");
  const expired = new Date(now.getTime() - 1000);
  const renewed = new Date(now.getTime() + 120000);
  const dbRow = {
    id: member.id, inviteStatus: "SENDING", inviteAttempt: 3,
    inviteAttemptAt: new Date(now.getTime() - 20000),
    inviteLeaseUntil: expired, acceptedAt: null, revokedAt: null,
    inviteProviderId: null, inviteErrorCode: null,
  };
  // Both requests observed the same expired lease before either writes.
  const snapshot = { ...dbRow };
  const prisma = {
    partnerMembership: {
      async updateMany({ where, data }) {
        assert.equal(where.id, dbRow.id);
        assert.equal(where.inviteAttempt, snapshot.inviteAttempt);
        assert.equal(where.inviteAttemptAt?.getTime(), snapshot.inviteAttemptAt.getTime());
        assert.equal(where.inviteLeaseUntil?.getTime(), snapshot.inviteLeaseUntil.getTime());
        assert.deepEqual(where.AND, [{ inviteLeaseUntil: { lte: now } }]);
        // Simulate a concurrent delivery reclaim winning after the first read.
        dbRow.inviteLeaseUntil = renewed;
        const matches = dbRow.inviteStatus === where.inviteStatus &&
          dbRow.inviteAttempt === where.inviteAttempt &&
          dbRow.inviteLeaseUntil.getTime() === where.inviteLeaseUntil.getTime() &&
          dbRow.inviteLeaseUntil <= now &&
          dbRow.acceptedAt === null && dbRow.revokedAt === null;
        if (!matches) return { count: 0 };
        dbRow.inviteAttempt += data.inviteAttempt.increment;
        return { count: 1 };
      },
    },
  };
  assert.equal(await resetInvitationAttempt(prisma, snapshot, now), false);
  assert.equal(dbRow.inviteAttempt, 3, "The in-flight send retains its provider idempotency key");
  assert.equal(dbRow.inviteLeaseUntil, renewed);
});

test("unchanged expired lease may be reset once, and stale second admin request is rejected", async () => {
  const now = new Date("2026-11-13T19:00:00.000Z");
  const row = {
    id: member.id, inviteStatus: "SENDING", inviteAttempt: 2,
    inviteAttemptAt: new Date(now.getTime() - 40000),
    inviteLeaseUntil: new Date(now.getTime() - 1000),
    acceptedAt: null, revokedAt: null,
  };
  const snapshot = { ...row };
  let writes = 0;
  const prisma = {
    partnerMembership: {
      async updateMany({ where, data }) {
        const matches = row.id === where.id &&
          row.inviteStatus === where.inviteStatus &&
          row.inviteAttempt === where.inviteAttempt &&
          row.inviteLeaseUntil?.getTime() === where.inviteLeaseUntil?.getTime() &&
          row.inviteAttemptAt?.getTime() === where.inviteAttemptAt?.getTime() &&
          (!where.AND || row.inviteLeaseUntil <= where.AND[0].inviteLeaseUntil.lte);
        if (!matches) return { count: 0 };
        row.inviteAttempt += data.inviteAttempt.increment;
        row.inviteStatus = data.inviteStatus;
        row.inviteAttemptAt = null;
        row.inviteLeaseUntil = null;
        writes++;
        return { count: 1 };
      },
    },
  };
  const outcomes = await Promise.all([
    resetInvitationAttempt(prisma, snapshot, now),
    resetInvitationAttempt(prisma, snapshot, now),
  ]);
  assert.deepEqual(outcomes.sort(), [false, true]);
  assert.equal(row.inviteAttempt, 3);
  assert.equal(writes, 1, "Only one request may allocate the next provider key");
});

test("active or missing lease cannot be overridden through explicit resend", async () => {
  const now = new Date("2026-11-13T19:00:00.000Z");
  const prisma = { partnerMembership: { updateMany: () => {
    throw new Error("Active lease must not reach database write");
  } } };
  const base = { id: member.id, inviteStatus: "SENDING",
    inviteAttempt: 0, acceptedAt: null, revokedAt: null };
  assert.equal(await resetInvitationAttempt(prisma, { ...base,
    inviteLeaseUntil: new Date(now.getTime() + 5000) }, now), false);
  assert.equal(await resetInvitationAttempt(prisma, { ...base,
    inviteLeaseUntil: null }, now), false);
});
