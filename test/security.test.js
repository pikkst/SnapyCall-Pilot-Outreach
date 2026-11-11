import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { encryptKey, decryptKey, makeSession, verifySession, requireRuntimeConfig, getEncryptionKey } from "../server/security.js";
import { generateDraft, parseDraft } from "../server/ai.js";

test("API key envelope encryption is randomized and authenticated", () => {
  const key = randomBytes(32).toString("hex");
  const a = encryptKey("sensitive-api-key-value", key);
  const b = encryptKey("sensitive-api-key-value", key);
  assert.notEqual(a, b);
  assert.equal(decryptKey(a, key), "sensitive-api-key-value");
  // Flip a significant character in the authenticated GCM tag deterministically.
  const parts = a.split(".");
  parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
  assert.throws(() => decryptKey(parts.join("."), key));
  assert.ok(!a.includes("sensitive"));
});
test("session is signed and cannot be forged", () => {
  const key = randomBytes(32).toString("hex");
  const session = makeSession(key);
  assert.equal(verifySession(session, key), true);
  assert.equal(verifySession(session, randomBytes(32).toString("hex")), false);
  assert.equal(verifySession("invalid", key), false);
});
test("required production credentials fail closed", () => {
  assert.throws(() => requireRuntimeConfig({}));
});
test("AI provider model selection is bounded to provider endpoints", async () => {
  let called;
  const result = await generateDraft({
    provider: "openai", model: "gpt-4.1-mini", apiKey: "sample-test-api-key",
    candidate: { name: "A", category: "COACHING", sourceUrl: "https://example.org" },
  }, { post: async (url, headers) => {
    called = { url, headers };
    return { choices: [{ message: { content: "Join the pilot\n\nHello, this is a draft." } }] };
  } });
  assert.equal(called.url, "https://api.openai.com/v1/chat/completions");
  assert.deepEqual(result, { subject: "Join the pilot", body: "Hello, this is a draft." });
  await assert.rejects(() => generateDraft({
    provider: "openai", model: "http://evil.invalid", apiKey: "sample-test-api-key", candidate: {},
  }), /Invalid/);
});
test("invalid AI draft is rejected", () => assert.throws(() => parseDraft("Only subject")));

test("generated 256-bit base64 secrets round-trip and hex compatibility", () => {
  const raw = randomBytes(32);
  for (const key of [raw.toString("hex"), raw.toString("base64")]) {
    assert.deepEqual(getEncryptionKey(key), raw);
    const ciphertext = encryptKey("provider-api-key-example", key);
    assert.equal(decryptKey(ciphertext, key), "provider-api-key-example");
  }
  assert.throws(() => getEncryptionKey("invalid-or-short"));
  assert.throws(() => getEncryptionKey(randomBytes(16).toString("base64")));
  const wrongKey = randomBytes(32).toString("base64");
  const ciphertext = encryptKey("provider-api-key-example", raw.toString("base64"));
  assert.throws(() => decryptKey(ciphertext, wrongKey));
});
