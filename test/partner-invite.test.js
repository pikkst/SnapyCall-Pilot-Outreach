import test from "node:test";
import assert from "node:assert/strict";
import { invitationMailerConfig, renderPartnerInvitation,
  deliverPartnerInvitation } from "../server/partner-invite.js";

const config = { apiKey: "ci-provider-key", from: "invites@example.org",
  appUrl: "https://pilot.example.org" };

function fakeDb() {
  const row = {
    id: "delivery-1", membershipId: "membership-1",
    emailNormalized: "partner@example.org", deliveryKey: "delivery-key-1",
    status: "PENDING", attempts: 0,
    membership: { revokedAt: null, partner: { name: 'Partner <Team>' } },
  };
  return {
    row,
    partnerInviteDelivery: {
      async updateMany({ where, data }) {
        if (row.id !== where.id || !where.status.in.includes(row.status)) return { count: 0 };
        row.status = data.status;
        row.claimedAt = data.claimedAt;
        row.attempts++;
        row.errorCode = data.errorCode;
        return { count: 1 };
      },
      async findUnique() { return row; },
      async update({ data }) { Object.assign(row, data); return row; },
    },
  };
}

test("sender configuration fails closed and only permits a canonical HTTPS URL", () => {
  assert.equal(invitationMailerConfig({}), null);
  assert.deepEqual(invitationMailerConfig({
    RESEND_API_KEY: config.apiKey, PARTNER_INVITE_FROM: config.from,
    PARTNER_INVITE_APP_URL: config.appUrl,
  }), config);
  assert.throws(() => invitationMailerConfig({
    RESEND_API_KEY: "key", PARTNER_INVITE_FROM: config.from,
    PARTNER_INVITE_APP_URL: "http://pilot.example.org",
  }));
});

test("invitation markup escapes partner-controlled text", () => {
  const msg = renderPartnerInvitation({ workspaceName: '<script>"&',
    signInUrl: config.appUrl });
  assert.equal(msg.html.includes("<script>"), false);
  assert.match(msg.html, /&lt;script&gt;/);
  assert.match(msg.text, /https:\/\/pilot\.example\.org/);
});

test("email delivery is disabled without a configured verified sender", async () => {
  const db = fakeDb();
  const result = await deliverPartnerInvitation(db, db.row.id, null, () => {
    throw new Error("should not send");
  });
  assert.equal(result.emailStatus, "NOT_CONFIGURED");
  assert.equal(db.row.status, "PENDING");
  assert.equal(db.row.attempts, 0);
});

test("one claim sends exactly one message with durable provider idempotency key", async () => {
  const db = fakeDb();
  let calls = 0;
  const sender = async (url, init) => {
    calls++;
    assert.equal(url, "https://api.resend.com/emails");
    assert.equal(init.headers["Idempotency-Key"], db.row.deliveryKey);
    const payload = JSON.parse(init.body);
    assert.deepEqual(payload.to, [db.row.emailNormalized]);
    assert.equal(payload.text.includes("https://pilot.example.org"), true);
    return { ok: true, json: async () => ({ id: "provider-id-1" }) };
  };
  assert.equal((await deliverPartnerInvitation(db, db.row.id, config, sender)).emailStatus, "SENT");
  assert.equal((await deliverPartnerInvitation(db, db.row.id, config, sender)).emailStatus, "SENT");
  assert.equal(calls, 1);
  assert.equal(db.row.attempts, 1);
  assert.equal(db.row.providerMessageId, "provider-id-1");
});

test("provider failure retains membership and supports explicit retry", async () => {
  const db = fakeDb();
  assert.equal((await deliverPartnerInvitation(db, db.row.id, config,
    async () => ({ ok: false }))).emailStatus, "FAILED");
  assert.equal(db.row.status, "FAILED");
  assert.equal(db.row.membership.revokedAt, null);
  assert.equal((await deliverPartnerInvitation(db, db.row.id, config,
    async () => ({ ok: true, json: async () => ({ id: "successful-retry" }) }))).emailStatus, "SENT");
  assert.equal(db.row.attempts, 2);
});

test("revoked memberships never send invitations", async () => {
  const db = fakeDb();
  db.row.membership.revokedAt = new Date();
  const result = await deliverPartnerInvitation(db, db.row.id, config, () => {
    throw new Error("should not send");
  });
  assert.equal(result.emailStatus, "FAILED");
  assert.equal(db.row.errorCode, "REVOKED");
});
