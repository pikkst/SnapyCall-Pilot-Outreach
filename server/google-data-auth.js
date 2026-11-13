import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FLOW_TTL_MS = 10 * 60_000;
export const DATA_SCOPES = Object.freeze([
  "openid", "email",
  "https://www.googleapis.com/auth/forms.responses.readonly",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
]);

function sign(payload, key) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return encoded + "." + createHmac("sha256", key).update(encoded).digest("base64url");
}

function verifySigned(value, key) {
  if (typeof value !== "string" || value.length > 4096) return null;
  const parts = value.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const signature = createHmac("sha256", key).update(parts[0]).digest("base64url");
  const a = Buffer.from(signature), b = Buffer.from(parts[1]);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try { return JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); }
  catch { return null; }
}

export function googleDataConfig(env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_DATA_REDIRECT_URI) return null;
  const url = new URL(env.GOOGLE_DATA_REDIRECT_URI);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      url.pathname !== "/api/partner/google/connect/callback") {
    throw new Error("Invalid Google data OAuth callback URL");
  }
  return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: env.GOOGLE_DATA_REDIRECT_URI };
}

export function createGoogleDataFlow(config, signingKey, { userId, partnerId }, now = Date.now()) {
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const url = new URL(AUTH_URL);
  for (const [name, value] of Object.entries({
    client_id: config.clientId, redirect_uri: config.redirectUri, response_type: "code",
    scope: DATA_SCOPES.join(" "), state, nonce,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256", access_type: "offline", prompt: "consent",
  })) url.searchParams.set(name, value);
  const cookie = sign({ purpose: "google_data", userId, partnerId, state, nonce, verifier,
    expires: now + FLOW_TTL_MS }, signingKey);
  return { url: url.toString(), cookie };
}

export function verifyGoogleDataFlow(cookie, state, signingKey, now = Date.now()) {
  const flow = verifySigned(cookie, signingKey);
  if (!flow || flow.purpose !== "google_data" || !Number.isSafeInteger(flow.expires) ||
      flow.expires <= now || flow.expires > now + FLOW_TTL_MS ||
      typeof state !== "string" || !/^[\w-]{43}$/.test(state) ||
      !/^[\\w-]{43}$/.test(flow.state ?? "") ||
      !timingSafeEqual(Buffer.from(state), Buffer.from(flow.state)) ||
      !/^[\w-]{43}$/.test(flow.verifier ?? "") ||
      !/^[\w-]{43}$/.test(flow.nonce ?? "") ||
      !/^c[a-z0-9]{10,40}$/.test(flow.userId ?? "") ||
      !/^c[a-z0-9]{10,40}$/.test(flow.partnerId ?? "")) return null;
  return flow;
}

export async function exchangeGoogleDataCode(code, flow, config, fetcher = fetch) {
  if (typeof code !== "string" || !code || code.length > 2048) throw new Error("Invalid authorization code");
  const body = new URLSearchParams({
    code, client_id: config.clientId, client_secret: config.clientSecret,
    redirect_uri: config.redirectUri, grant_type: "authorization_code",
    code_verifier: flow.verifier,
  });
  const result = await fetcher(TOKEN_URL, { method: "POST", redirect: "error",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(), signal: AbortSignal.timeout(8000) });
  if (!result.ok) throw new Error("Google data authorization failed");
  const response = await result.json();
  if (typeof response.id_token !== "string" || typeof response.refresh_token !== "string" ||
      response.refresh_token.length < 8 || response.refresh_token.length > 4096 ||
      typeof response.scope !== "string" || !requiredScopesGranted(response.scope)) {
    throw new Error("Google did not grant required offline permissions");
  }
  return response;
}

export function requiredScopesGranted(granted) {
  if (typeof granted !== "string") return false;
  const scopes = new Set(granted.split(/\s+/).filter(Boolean));
  return DATA_SCOPES.filter(scope => scope !== "email").every(scope => scopes.has(scope)) &&
    (scopes.has("email") || scopes.has("https://www.googleapis.com/auth/userinfo.email"));
}
