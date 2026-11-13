import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";

const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const FLOW_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 8 * 60 * 60_000;

function hmac(payload, key) {
  return createHmac("sha256", key).update(payload).digest("base64url");
}
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function sign(data, key) {
  const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
  return payload + "." + hmac(payload, key);
}
function unsign(value, key) {
  if (typeof value !== "string" || value.length > 4096) return null;
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra || !safeEqual(hmac(payload, key), signature)) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch { return null; }
}

export function googleOAuthConfig(env) {
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret,
    GOOGLE_REDIRECT_URI: redirectUri } = env;
  if (!clientId || !clientSecret || !redirectUri) return null;
  const uri = new URL(redirectUri);
  if (uri.protocol !== "https:" || uri.username || uri.password ||
      uri.search || uri.hash || uri.pathname !== "/api/auth/google/callback") {
    throw new Error("Invalid Google OAuth callback URL");
  }
  return { clientId, clientSecret, redirectUri };
}

export function createGoogleFlow(config, key, now = Date.now()) {
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const cookie = sign({ purpose: "google_flow", state, nonce, verifier, expires: now + FLOW_TTL_MS }, key);
  const uri = new URL(AUTH_URL);
  for (const [name, value] of Object.entries({
    client_id: config.clientId, redirect_uri: config.redirectUri,
    response_type: "code", scope: "openid email profile",
    state, nonce, code_challenge: challenge, code_challenge_method: "S256",
    prompt: "select_account",
  })) uri.searchParams.set(name, value);
  return { url: uri.toString(), cookie };
}

export function verifyGoogleFlow(cookie, state, key, now = Date.now()) {
  const flow = unsign(cookie, key);
  if (!flow || flow.purpose !== "google_flow" || !Number.isSafeInteger(flow.expires) || flow.expires <= now ||
      flow.expires > now + FLOW_TTL_MS || !safeEqual(flow.state, state) ||
      !/^[a-zA-Z0-9_-]{43}$/.test(flow.verifier ?? "") ||
      !/^[a-zA-Z0-9_-]{43}$/.test(flow.nonce ?? "")) return null;
  return flow;
}

export function createPartnerSession(userId, key, now = Date.now()) {
  return sign({ purpose: "partner", userId, expires: now + SESSION_TTL_MS,
    nonce: randomBytes(16).toString("base64url") }, key);
}
export function verifyPartnerSession(value, key, now = Date.now()) {
  const data = unsign(value, key);
  if (data?.purpose !== "partner" || typeof data.userId !== "string" ||
      !/^c[a-z0-9]{10,40}$/.test(data.userId) ||
      !Number.isSafeInteger(data.expires) || data.expires <= now ||
      data.expires > now + SESSION_TTL_MS) return null;
  return data.userId;
}

function parseJwtPart(part) {
  if (typeof part !== "string" || !/^[a-zA-Z0-9_-]+$/.test(part)) throw new Error("Invalid ID token");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

export async function verifyGoogleIdToken(idToken, config, nonce, fetcher = fetch, now = Date.now()) {
  if (typeof idToken !== "string" || idToken.length > 10000) throw new Error("Invalid ID token");
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("Invalid ID token");
  const header = parseJwtPart(parts[0]);
  const claims = parseJwtPart(parts[1]);
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("Invalid signature algorithm");
  const res = await fetcher(JWKS_URL, { signal: AbortSignal.timeout(8000), redirect: "error" });
  if (!res.ok) throw new Error("Google certificate lookup failed");
  const keys = await res.json();
  const jwk = keys?.keys?.find(k => k.kid === header.kid && k.kty === "RSA" && k.use === "sig" && k.alg === "RS256");
  if (!jwk || !verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]),
    createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(parts[2], "base64url"))) {
    throw new Error("ID token signature invalid");
  }
  const seconds = Math.floor(now / 1000);
  if (!GOOGLE_ISSUERS.has(claims.iss) || claims.aud !== config.clientId ||
      (claims.azp && claims.azp !== config.clientId) ||
      !Number.isSafeInteger(claims.exp) || claims.exp <= seconds ||
      !Number.isSafeInteger(claims.iat) || claims.iat > seconds + 60 ||
      claims.nonce !== nonce || claims.email_verified !== true ||
      typeof claims.sub !== "string" || !claims.sub ||
      typeof claims.email !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(claims.email)) {
    throw new Error("Invalid Google identity claims");
  }
  return { googleSub: claims.sub, emailNormalized: claims.email.trim().toLowerCase(),
    displayName: typeof claims.name === "string" ? claims.name.slice(0, 160) : null };
}

export async function exchangeGoogleCode(code, flow, config, fetcher = fetch) {
  if (typeof code !== "string" || !code || code.length > 2048) throw new Error("Invalid authorization code");
  const params = new URLSearchParams({
    code, client_id: config.clientId, client_secret: config.clientSecret,
    redirect_uri: config.redirectUri, grant_type: "authorization_code",
    code_verifier: flow.verifier,
  });
  const res = await fetcher(TOKEN_URL, { method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(), signal: AbortSignal.timeout(8000), redirect: "error" });
  if (!res.ok) throw new Error("Google authorization exchange failed");
  const tokens = await res.json();
  if (typeof tokens.id_token !== "string") throw new Error("Missing Google ID token");
  return tokens.id_token;
}
