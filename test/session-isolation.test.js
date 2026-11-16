import test from "node:test";
import assert from "node:assert/strict";
import { makeSession } from "../server/security.js";
import { createPartnerSession } from "../server/google-auth.js";
import { canUseAdminSession, sessionIdentityState } from "../server/session-isolation.js";

const key = "unit-test-session-signing-key-at-least-thirty-two";
const user = "cmw123456789ab123456789";

test("only a valid admin cookie authorizes privileged routes", () => {
  const admin = makeSession(key);
  const partner = createPartnerSession(user, key);
  assert.deepEqual(sessionIdentityState({}, key), {
    admin: false, partner: false, conflict: false,
  });
  assert.equal(canUseAdminSession({ pilot_session: admin }, key), true);
  assert.equal(canUseAdminSession({ pilot_partner_session: partner }, key), false);
  assert.equal(canUseAdminSession({
    pilot_session: admin, pilot_partner_session: partner,
  }, key), false, "two simultaneous identities must never inherit admin privileges");
});

test("both valid cookies always produce a session conflict regardless of UI preference", () => {
  const cookies = {
    pilot_session: makeSession(key),
    pilot_partner_session: createPartnerSession(user, key),
  };
  assert.deepEqual(sessionIdentityState(cookies, key), {
    admin: true, partner: true, conflict: true,
  });
  const afterGoogleLogin = { ...cookies, pilot_session: "" };
  assert.deepEqual(sessionIdentityState(afterGoogleLogin, key), {
    admin: false, partner: true, conflict: false,
  });
  const afterAdminLogin = { ...cookies, pilot_partner_session: "" };
  assert.deepEqual(sessionIdentityState(afterAdminLogin, key), {
    admin: true, partner: false, conflict: false,
  });
});

test("expired, forged and incorrectly signed partner cookies cannot create admin identity", () => {
  const admin = makeSession(key);
  const partner = createPartnerSession(user, key);
  const expired = createPartnerSession(user, key, Date.now() - 9 * 60 * 60_000);
  for (const value of [expired, partner + "tampered",
    createPartnerSession(user, "different-key-different-key-different-key")]) {
    assert.deepEqual(sessionIdentityState({
      pilot_session: admin, pilot_partner_session: value,
    }, key), { admin: true, partner: false, conflict: false });
  }
  assert.equal(canUseAdminSession({
    pilot_session: "bogus", pilot_partner_session: partner,
  }, key), false);
});

test("invalid signing keys and stolen partner-only cookies cannot authorize admin actions", () => {
  const partner = createPartnerSession(user, key);
  assert.equal(canUseAdminSession({
    pilot_partner_session: partner,
  }, "different-key-different-key-different-key"), false);
  assert.equal(canUseAdminSession({ pilot_session: partner }, key), false);
});
