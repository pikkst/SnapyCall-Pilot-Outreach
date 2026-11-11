import test from "node:test";
import assert from "node:assert/strict";
import { signScanEntry, verifyScanEntry } from "../server/discovery-proof.js";

const secret = "secure-test-session-signing-secret-0123456789";
const entry = { discoveryKey: "key-1", name: "Alice Example", feedUrl: "https://example.org/feed",
  sourceUrl: "https://example.org/author-alice/article" };

test("scan proof permits only exact evidence returned in the active session window", () => {
  const original = signScanEntry(entry, secret, 1000000000000);
  assert.equal(verifyScanEntry(original, secret, 1000000000100), true);
  assert.equal(verifyScanEntry({ ...original, name: "Invented Expert" }, secret, 1000000000100), false);
  assert.equal(verifyScanEntry({ ...original, sourceUrl: "https://attacker.org/" }, secret, 1000000000100), false);
  assert.equal(verifyScanEntry({ ...original, feedUrl: "https://other.org/feed" }, secret, 1000000000100), false);
  assert.equal(verifyScanEntry({ ...original, discoveryKey: "alternate-key" }, secret, 1000000000100), false);
});
test("expired, future, malformed and differently signed proofs fail closed", () => {
  const original = signScanEntry(entry, secret, 1000000000000);
  assert.equal(verifyScanEntry(original, secret, 1000000600000), false);
  assert.equal(verifyScanEntry(original, secret, 999999900000), false);
  assert.equal(verifyScanEntry(original, "different-secret", 1000000000100), false);
  assert.equal(verifyScanEntry({ ...original, proof: "invalid" }, secret, 1000000000100), false);
  assert.equal(verifyScanEntry({ ...original, proof: "" }, secret, 1000000000100), false);
});
