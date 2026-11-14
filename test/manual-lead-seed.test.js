import test from "node:test";
import assert from "node:assert/strict";
import { normalizeManualLeadSeed } from "../server/manual-lead-seed.js";

const input = {
  manualSeed: true, name: "  Alex   Example  ",
  category: "COACHING", sourceUrl: "https://Directory.Example.org/member/alex/?utm_source=chat#bio",
};

test("manual seed is canonical, idempotent and has no contact attestation", () => {
  const one = normalizeManualLeadSeed(input);
  const repeat = normalizeManualLeadSeed({ ...input,
    name: "Alex Example", sourceUrl: "https://directory.example.org/member/alex" });
  assert.equal(one.name, "Alex Example");
  assert.equal(one.sourceUrl, "https://directory.example.org/member/alex");
  assert.match(one.discoveryKey, /^[a-f0-9]{64}$/);
  assert.equal(one.discoveryKey, repeat.discoveryKey);
  assert.equal(Object.hasOwn(one, "email"), false);
  assert.equal(Object.hasOwn(one, "contactReviewed"), false);
  assert.equal(Object.hasOwn(one, "profileReviewed"), false);
});

test("manual seed rejects client attempts to assert outreach permission or set tenancy", () => {
  for (const fields of [
    { email: "guessed@example.org" }, { contactReviewed: true },
    { profileReviewed: true }, { legalBasis: "consent" },
    { workspaceId: "fake" }, { onlineEnglish: true },
    { manualSeed: false },
  ]) assert.throws(() => normalizeManualLeadSeed({ ...input, ...fields }));
});

test("manual seed requires safe HTTPS profile references", () => {
  for (const sourceUrl of [
    "http://directory.example.org/member", "https://localhost/admin",
    "https://192.168.1.1/private", "https://user:password@directory.example.org/a",
    "https://directory.example.org:444/a", "javascript:alert(1)",
  ]) assert.throws(() => normalizeManualLeadSeed({ ...input, sourceUrl }));
});

test("manual seed identity differs by human identity or distinct source", () => {
  const one = normalizeManualLeadSeed(input);
  assert.notEqual(normalizeManualLeadSeed({ ...input, name: "Other Expert" }).discoveryKey,
    one.discoveryKey);
  assert.notEqual(normalizeManualLeadSeed({
    ...input, sourceUrl: "https://directory.example.org/member/other",
  }).discoveryKey, one.discoveryKey);
});
