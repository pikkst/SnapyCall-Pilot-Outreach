import { createCipheriv, createDecipheriv, createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function requireRuntimeConfig(env = process.env) {
  const names = ["DATABASE_URL", "ADMIN_EMAIL", "SESSION_SIGNING_KEY", "AI_ENCRYPTION_KEY"];
  for (const name of names) {
    if (!env[name]) throw new Error("Missing server configuration: " + name);
  }
  if (env.SESSION_SIGNING_KEY.length < 32) throw new Error("SESSION_SIGNING_KEY must be at least 32 characters");
  getEncryptionKey(env.AI_ENCRYPTION_KEY);
  return env;
}

// Accept 32-byte hex (legacy) or 256-bit base64 from managed secret generators.
// Do not rotate this value without re-encrypting persisted API credentials.
export function getEncryptionKey(value) {
  if (typeof value === "string" && /^[a-f0-9]{64}$/i.test(value)) return Buffer.from(value, "hex");
  if (typeof value === "string" && /^[a-zA-Z0-9+/]{43}=$/.test(value)) return Buffer.from(value, "base64");
  throw new Error("AI_ENCRYPTION_KEY must encode exactly 32 random bytes");
}

export function encryptKey(value, secretKey) {
  if (typeof value !== "string" || value.length < 8 || value.length > 4096) throw new Error("Invalid API key");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(secretKey), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptKey(value, secretKey) {
  const [version, iv, tag, ciphertext, extra] = value.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext || extra) throw new Error("Invalid encrypted secret");
  const decipher = createDecipheriv("aes-256-gcm", getEncryptionKey(secretKey), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

export function keyFingerprint(secret) {
  return createHash("sha256").update(secret).digest("hex").slice(0, 12);
}

function hmac(value, signingKey) {
  return createHmac("sha256", signingKey).update(value).digest("base64url");
}

export function makeSession(signingKey) {
  const expiry = Date.now() + 8 * 60 * 60 * 1000;
  const payload = Buffer.from(JSON.stringify({ user: "admin", expiry, nonce: randomBytes(16).toString("hex") })).toString("base64url");
  return payload + "." + hmac(payload, signingKey);
}

export function verifySession(token, signingKey) {
  if (typeof token !== "string" || token.length > 2048) return false;
  const [payload, signature, rest] = token.split(".");
  if (!payload || !signature || rest) return false;
  const expected = hmac(payload, signingKey);
  const a = Buffer.from(signature), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return data.user === "admin" && Number.isSafeInteger(data.expiry) && data.expiry > Date.now();
  } catch { return false; }
}

export function validWriteOrigin(req) {
  const origin = req.get("origin");
  const host = req.get("host");
  if (!origin || !host) return false;
  try {
    const originUrl = new URL(origin);
    const forwardedProto = req.secure ? "https:" : "http:";
    return originUrl.origin === new URL(forwardedProto + "//" + host).origin;
  } catch { return false; }
}
