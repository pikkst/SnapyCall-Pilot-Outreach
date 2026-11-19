import test from "node:test";
import assert from "node:assert/strict";
import { classifyPersonSourceInspectionFailure }
  from "../server/research-person-source-evidence.js";

test("known HTTPS reader failures are audit-only bounded categories", () => {
  for (const code of [
    "PUBLIC_PAGE_URL_REJECTED", "PUBLIC_PAGE_DNS_REJECTED",
    "PUBLIC_PAGE_NO_VALID_IPV4", "PUBLIC_PAGE_REDIRECT_REJECTED",
    "PUBLIC_PAGE_HTTP_REJECTED", "PUBLIC_PAGE_TOO_LARGE",
    "PUBLIC_PAGE_TIMEOUT", "PUBLIC_PAGE_ROBOTS_REJECTED",
    "PUBLIC_PAGE_CONTENT_REJECTED",
  ]) {
    assert.equal(classifyPersonSourceInspectionFailure(new Error(code)), code);
  }
});

test("arbitrary upstream exceptions do not disclose external details in audit", () => {
  assert.equal(classifyPersonSourceInspectionFailure(
    new Error("HTTPS 403 at https://private.example.test/leaked?token=secret")),
  "PUBLIC_PAGE_OTHER_UNAVAILABLE");
  assert.equal(classifyPersonSourceInspectionFailure(
    new Error("PUBLIC_PAGE_HTTP_REJECTED with response body")),
  "PUBLIC_PAGE_OTHER_UNAVAILABLE");
  assert.equal(classifyPersonSourceInspectionFailure({ message: "PUBLIC_PAGE_TIMEOUT" }),
    "PUBLIC_PAGE_OTHER_UNAVAILABLE");
  assert.equal(classifyPersonSourceInspectionFailure(null),
    "PUBLIC_PAGE_OTHER_UNAVAILABLE");
});
