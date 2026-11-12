import test from "node:test";
import assert from "node:assert/strict";
import { canonicalEvidenceUrl, sameIdentityHints, EVIDENCE_KINDS } from "../src/evidence.js";

test("canonical evidence URLs preserve the factual path but normalize tracking", () => {
  assert.equal(canonicalEvidenceUrl("https://EXAMPLE.org/coach/?utm_source=mail&b=2&a=1#about"),
    "https://example.org/coach?a=1&b=2");
  assert.equal(canonicalEvidenceUrl("https://example.org/coach/"),
    canonicalEvidenceUrl("https://example.org/coach"));
});
test("evidence URLs must be HTTPS public DNS hostnames without credentials", () => {
  for (const url of ["http://example.org/a", "https://localhost/a",
    "https://127.0.0.1/a", "https://user:pass@example.org/a", "file:///secret",
    "https://example.org:8443/a", "https://internal.local/a", "https://example..org/"]) {
    assert.throws(() => canonicalEvidenceUrl(url));
  }
  assert.deepEqual(EVIDENCE_KINDS, ["ARTICLE", "PROFILE", "SERVICE", "OTHER"]);
});
test("only exact normalized profile or email can suggest a duplicate", () => {
  const source = { id: "a", name: "Pat", expertProfileUrl: "https://example.org/pat/?utm_source=x",
    emailNormalized: "pat@example.org" };
  const other = [
    { id: "b", name: "Pat", expertProfileUrl: "https://other.org/pat" },
    { id: "c", name: "Nobody", expertProfileUrl: "https://example.org/pat",
      emailNormalized: "another@example.org" },
    { id: "d", name: "Different", emailNormalized: "PAT@example.org" },
    { ...source },
  ];
  assert.deepEqual(sameIdentityHints(source, other), [
    { id: "c", reasons: ["same_profile_url"] },
    { id: "d", reasons: ["same_verified_email"] },
  ]);
});
test("homonymous names never create a suggestion", () => {
  assert.deepEqual(sameIdentityHints({ id: "1", name: "Same" }, [{ id: "2", name: "Same" }]), []);
});
