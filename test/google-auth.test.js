import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as rsaSign } from "node:crypto";
import {
  createGoogleFlow, verifyGoogleFlow, googleOAuthConfig,
  createPartnerSession, verifyPartnerSession, verifyGoogleIdToken, exchangeGoogleCode,
} from "../server/google-auth.js";

const cfg = { clientId: "example-client.apps.googleusercontent.com",
  clientSecret: "test-only-secret", redirectUri: "https://pilot.example.org/api/auth/google/callback" };
const key = "test-only-signing-key-at-least-thirty-two-characters";

test("Google OAuth configuration is optional but restricts callback URL", () => {
  assert.equal(googleOAuthConfig({}), null);
  assert.deepEqual(googleOAuthConfig({
    GOOGLE_CLIENT_ID: cfg.clientId, GOOGLE_CLIENT_SECRET: cfg.clientSecret,
    GOOGLE_REDIRECT_URI: cfg.redirectUri,
  }), cfg);
  assert.throws(() => googleOAuthConfig({
    GOOGLE_CLIENT_ID: cfg.clientId, GOOGLE_CLIENT_SECRET: cfg.clientSecret,
    GOOGLE_REDIRECT_URI: "http://localhost/api/auth/google/callback",
  }));
});

test("Google flow binds state, nonce, PKCE, and one-use short expiry", () => {
  const now = Date.now();
  const flow = createGoogleFlow(cfg, key, now);
  const params = new URL(flow.url).searchParams;
  assert.equal(params.get("scope"), "openid email profile");
  assert.equal(params.get("code_challenge_method"), "S256");
  const verified = verifyGoogleFlow(flow.cookie, params.get("state"), key, now);
  assert.ok(verified);
  assert.equal(verified.nonce, params.get("nonce"));
  assert.equal(createHash("sha256").update(verified.verifier).digest("base64url"), params.get("code_challenge"));
  assert.equal(verifyGoogleFlow(flow.cookie, "wrong-state", key, now), null);
  assert.equal(verifyGoogleFlow(flow.cookie + "forged", params.get("state"), key, now), null);
  assert.equal(verifyGoogleFlow(flow.cookie, params.get("state"), key, now + 601000), null);
});

test("partner session has purpose, signed expiry and tamper protection", () => {
  const now = Date.now();
  const userId = "cmw123456789ab123456789";
  const session = createPartnerSession(userId, key, now);
  assert.equal(verifyPartnerSession(session, key, now), userId);
  assert.equal(verifyPartnerSession(session + ".", key, now), null);
  assert.equal(verifyPartnerSession(session, key, now + 9 * 3600000), null);
  assert.equal(verifyPartnerSession(session, "different-key-different-key-different-key", now), null);
});

test("Google ID token requires cryptographic signature, verified email and exact claims", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pub = publicKey.export({ format: "jwk" });
  const jwk = { ...pub, kid: "test-key", use: "sig", alg: "RS256" };
  const now = Date.now(), seconds = Math.floor(now / 1000);
  const fetcher = async () => ({ ok: true, json: async () => ({ keys: [jwk] }) });
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: jwk.kid })).toString("base64url");
  const claims = { iss: "https://accounts.google.com", aud: cfg.clientId,
    sub: "google-unique-sub", email: "Partner@Example.ORG", email_verified: true,
    name: "Partner", nonce: "expected-nonce", iat: seconds, exp: seconds + 3600 };
  const tokenFor = (overrides = {}) => {
    const body = Buffer.from(JSON.stringify({ ...claims, ...overrides })).toString("base64url");
    const unsigned = header + "." + body;
    return unsigned + "." + rsaSign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url");
  };
  assert.deepEqual(await verifyGoogleIdToken(tokenFor(), cfg, "expected-nonce", fetcher, now), {
    googleSub: "google-unique-sub", emailNormalized: "partner@example.org", displayName: "Partner",
  });
  for (const overrides of [
    { aud: "other-client" }, { nonce: "wrong" }, { email_verified: false },
    { exp: seconds - 1 }, { iat: seconds + 100 }, { iss: "https://evil.example.org" },
  ]) {
    await assert.rejects(() => verifyGoogleIdToken(tokenFor(overrides), cfg, "expected-nonce", fetcher, now));
  }
  // Mutate an actual signature byte, not a base64url character whose
  // replacement can leave the decoded signature unchanged.
  const validToken = tokenFor();
  const [signedHeader, signedPayload, encodedSignature] = validToken.split(".");
  const corruptedSignature = Buffer.from(encodedSignature, "base64url");
  corruptedSignature[0] ^= 0x01;
  const tampered = [signedHeader, signedPayload, corruptedSignature.toString("base64url")].join(".");
  assert.notEqual(tampered, validToken);
  await assert.rejects(() => verifyGoogleIdToken(tampered, cfg, "expected-nonce", fetcher, now));
});

test("authorization code exchange sends PKCE verifier to Google only", async () => {
  const flow = { verifier: "a".repeat(43) };
  let sent;
  const idToken = await exchangeGoogleCode("test-code", flow, cfg, async (url, init) => {
    sent = { url, ...init };
    return { ok: true, json: async () => ({ id_token: "mock-id-token" }) };
  });
  assert.equal(idToken, "mock-id-token");
  assert.equal(sent.url, "https://oauth2.googleapis.com/token");
  const args = new URLSearchParams(sent.body);
  assert.equal(args.get("code_verifier"), flow.verifier);
  assert.equal(args.get("client_secret"), cfg.clientSecret);
  assert.equal(args.get("grant_type"), "authorization_code");
});
