// This fixture runs only in the disposable PostgreSQL HTTP smoke subprocess.
// It replaces Google's HTTP responses, not production OAuth verification.
import { generateKeyPairSync, sign } from "node:crypto";

if (!process.env.DATABASE_URL?.includes("localhost:5432/pilot_test") ||
    process.env.PILOT_GOOGLE_MOCK !== "integration-only") {
  throw new Error("Google mock must never run outside the disposable CI smoke");
}

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "smoke-google-jwks",
  use: "sig", alg: "RS256" };
const realFetch = globalThis.fetch;

function issueIdToken(nonce, kind) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: "https://accounts.google.com",
    aud: process.env.GOOGLE_CLIENT_ID,
    sub: kind === "wrong-sub" ? "different-google-identity" : "google-test-sub",
    email: kind === "wrong-email" ? "intruder@example.org" : "partner@example.org",
    email_verified: true,
    nonce, iat: now, exp: now + 3600,
  };
  const head = Buffer.from(JSON.stringify({ alg: "RS256", kid: jwk.kid })).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const unsigned = head + "." + body;
  return unsigned + "." + sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url");
}

globalThis.fetch = async (url, options) => {
  const target = String(url);
  if (target === "https://api.resend.com/emails") {
    const key = options?.headers?.["Idempotency-Key"];
    const payload = JSON.parse(options.body);
    if (!/^snapycall-invite-c[a-z0-9]+-\d+$/.test(key ?? "") ||
        !payload.subject.includes("Invitation") ||
        !Array.isArray(payload.to) || !payload.to.length ||
        options.headers.authorization !== "Bearer " + process.env.RESEND_API_KEY) {
      return Response.json({ error: "invalid_email_request" }, { status: 400 });
    }
    return Response.json({ id: "fixture-email-" + key });
  }
  if (target === "https://www.googleapis.com/oauth2/v3/certs") {
    return Response.json({ keys: [jwk] });
  }
  if (target === "https://oauth2.googleapis.com/token") {
    const params = new URLSearchParams(options?.body);
    if (params.get("grant_type") !== "authorization_code" ||
        params.get("code_verifier")?.length !== 43 ||
        params.get("client_id") !== process.env.GOOGLE_CLIENT_ID ||
        params.get("client_secret") !== process.env.GOOGLE_CLIENT_SECRET) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const [nonce, kind] = (params.get("code") ?? "").split(":");
    if (!/^[a-zA-Z0-9_-]{43}$/.test(nonce ?? "")) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    return Response.json({
      id_token: issueIdToken(nonce, kind),
      refresh_token: "fixture-refresh-token-secret-value",
      scope: [
        "openid",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/forms.responses.readonly",
        "https://www.googleapis.com/auth/spreadsheets.readonly",
      ].join(" "),
      token_type: "Bearer", expires_in: 3600,
    });
  }
  return realFetch(url, options);
};
