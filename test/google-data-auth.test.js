import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { googleDataConfig, createGoogleDataFlow, verifyGoogleDataFlow,
  exchangeGoogleDataCode, requiredScopesGranted, requiredGmailScopesGranted,
  DATA_SCOPES, GMAIL_SEND_SCOPES, googleGmailConfig } from "../server/google-data-auth.js";
import { encryptKey, decryptKey } from "../server/security.js";

const config = { clientId: "test.apps.googleusercontent.com", clientSecret: "test-only-client-secret",
  redirectUri: "https://app.example.test/api/partner/google/connect/callback" };
const signing = "test-signing-key-at-least-32-characters";
const subject = { userId: "cmw123456789ab123456789", partnerId: "cmw123456789ab123456790" };

test("data OAuth is separately configured and requires HTTPS exact callback", () => {
  assert.equal(googleDataConfig({}), null);
  assert.deepEqual(googleDataConfig({ GOOGLE_CLIENT_ID: config.clientId,
    GOOGLE_CLIENT_SECRET: config.clientSecret, GOOGLE_DATA_REDIRECT_URI: config.redirectUri }), config);
  assert.throws(() => googleDataConfig({ GOOGLE_CLIENT_ID: config.clientId,
    GOOGLE_CLIENT_SECRET: config.clientSecret, GOOGLE_DATA_REDIRECT_URI: "http://app.test/api/partner/google/connect/callback" }));
});

test("offline Google consent binds nonce, workspace, user, state and PKCE", () => {
  const now = Date.now();
  const { url, cookie } = createGoogleDataFlow(config, signing, subject, now);
  const q = new URL(url).searchParams;
  assert.equal(q.get("access_type"), "offline");
  assert.equal(q.get("prompt"), "consent");
  assert.equal(q.get("scope"), DATA_SCOPES.join(" "));
  const flow = verifyGoogleDataFlow(cookie, q.get("state"), signing, now);
  assert.equal(flow.partnerId, subject.partnerId);
  assert.equal(flow.userId, subject.userId);
  assert.equal(flow.nonce, q.get("nonce"));
  assert.equal(createHash("sha256").update(flow.verifier).digest("base64url"), q.get("code_challenge"));
  assert.equal(verifyGoogleDataFlow(cookie, "x".repeat(43), signing, now), null);
  assert.equal(verifyGoogleDataFlow(cookie + "x", q.get("state"), signing, now), null);
  assert.equal(verifyGoogleDataFlow(cookie, q.get("state"), signing, now + 601000), null);
});

test("data OAuth requires explicit granted scopes and a refresh token", async () => {
  const flow = { verifier: "x".repeat(43) };
  const fetcher = async (url, request) => {
    assert.equal(url, "https://oauth2.googleapis.com/token");
    assert.equal(new URLSearchParams(request.body).get("code_verifier"), flow.verifier);
    return { ok: true, json: async () => ({ id_token: "test-id-token",
      refresh_token: "refresh-token-only-for-testing", scope: DATA_SCOPES.join(" ") }) };
  };
  const tokens = await exchangeGoogleDataCode("code", flow, config, fetcher);
  assert.equal(tokens.refresh_token, "refresh-token-only-for-testing");
  assert.equal(requiredScopesGranted("openid email"), false);
  assert.equal(requiredScopesGranted(DATA_SCOPES.filter(s => s !== "email").join(" ") +
    " https://www.googleapis.com/auth/userinfo.email"), true);
  await assert.rejects(() => exchangeGoogleDataCode("code", flow, config,
    async () => ({ ok: true, json: async () => ({ id_token: "mock", scope: DATA_SCOPES.join(" ") }) })));
  const secret = "a".repeat(64);
  const encrypted = encryptKey(tokens.refresh_token, secret);
  assert.equal(encrypted.includes(tokens.refresh_token), false);
  assert.equal(decryptKey(encrypted, secret), tokens.refresh_token);
});

test("Gmail consent is a distinct signed purpose with only gmail.send permission", () => {
  const gmail = { ...config, redirectUri: "https://app.example.test/api/partner/google/gmail/callback" };
  assert.deepEqual(googleGmailConfig({
    GOOGLE_CLIENT_ID: config.clientId, GOOGLE_CLIENT_SECRET: config.clientSecret,
    GOOGLE_GMAIL_REDIRECT_URI: gmail.redirectUri,
  }), gmail);
  assert.equal(googleGmailConfig({}), null);
  assert.throws(() => googleGmailConfig({
    GOOGLE_CLIENT_ID: config.clientId, GOOGLE_CLIENT_SECRET: config.clientSecret,
    GOOGLE_GMAIL_REDIRECT_URI: "http://app.example.test/api/partner/google/gmail/callback",
  }));
  const now = Date.now();
  const flowData = createGoogleDataFlow(gmail, signing, { ...subject, kind: "gmail" }, now);
  const q = new URL(flowData.url).searchParams;
  assert.equal(q.get("scope"), GMAIL_SEND_SCOPES.join(" "));
  assert.equal(q.get("access_type"), "offline");
  assert.equal(q.get("prompt"), "consent");
  assert.equal(verifyGoogleDataFlow(flowData.cookie, q.get("state"), signing, now), null,
    "Gmail send signed state must never be valid as Forms/Sheets read consent");
  assert.equal(verifyGoogleDataFlow(flowData.cookie, q.get("state"), signing, now, "gmail").partnerId,
    subject.partnerId);
  const forms = createGoogleDataFlow(config, signing, subject, now);
  assert.equal(verifyGoogleDataFlow(forms.cookie,
    new URL(forms.url).searchParams.get("state"), signing, now, "gmail"), null,
    "Forms/Sheets consent must not authorize Gmail sending");
  assert.equal(requiredGmailScopesGranted(DATA_SCOPES.join(" ")), false);
  assert.equal(requiredGmailScopesGranted(GMAIL_SEND_SCOPES.join(" ")), true);
  assert.equal(requiredGmailScopesGranted(
    "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.send"
  ), true);
});

test("Gmail token exchange rejects missing Gmail send scope and missing refresh token", async () => {
  const flow = { verifier: "x".repeat(43), purpose: "google_gmail_send" };
  const exchange = (scope, refresh = "separate-gmail-refresh-token") =>
    exchangeGoogleDataCode("test-code", flow, {
      ...config, redirectUri: "https://app.example.test/api/partner/google/gmail/callback",
    }, async () => ({
      ok: true,
      json: async () => ({
        id_token: "signed-token-in-http-smoke", refresh_token: refresh, scope,
      }),
    }));
  assert.equal((await exchange(GMAIL_SEND_SCOPES.join(" "))).refresh_token,
    "separate-gmail-refresh-token");
  await assert.rejects(() => exchange(DATA_SCOPES.join(" ")));
  await assert.rejects(() => exchange(GMAIL_SEND_SCOPES.join(" "), ""));
});
