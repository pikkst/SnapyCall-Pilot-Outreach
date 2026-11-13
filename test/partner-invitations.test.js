import test from "node:test";
import assert from "node:assert/strict";
import { invitationEmailConfig, createInvitationEmail,
  sendInvitationEmail, publicInvitationStatus } from "../server/partner-invitations.js";

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
