import { createHmac, timingSafeEqual } from "node:crypto";

// The browser can only import a result that was returned by a recent server-side scan.
// The signature is scoped to the exact feed, author, article and discovery identity.
const TTL_MS = 10 * 60 * 1000;

function payloadOf(item, expiresAt) {
  return JSON.stringify([
    item.discoveryKey, item.name, item.sourceUrl, item.feedUrl, expiresAt,
  ]);
}

function signature(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function signScanEntry(entry, secret, now = Date.now()) {
  const expiresAt = now + TTL_MS;
  const payload = payloadOf(entry, expiresAt);
  return { ...entry, proof: expiresAt + "." + signature(payload, secret) };
}

export function verifyScanEntry(entry, secret, now = Date.now()) {
  if (typeof entry?.proof !== "string" || entry.proof.length > 128) return false;
  const parts = entry.proof.split(".");
  if (parts.length !== 2 || !/^\d{13}$/.test(parts[0]) || !/^[\w-]{43}$/.test(parts[1])) return false;
  const expiry = Number(parts[0]);
  if (!Number.isSafeInteger(expiry) || expiry <= now || expiry > now + TTL_MS) return false;
  const expected = Buffer.from(signature(payloadOf(entry, expiry), secret));
  const supplied = Buffer.from(parts[1]);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}
