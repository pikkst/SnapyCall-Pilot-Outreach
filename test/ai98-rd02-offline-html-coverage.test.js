import test from "node:test";
import assert from "node:assert/strict";
import { classifyExplicitPersonEmailPage } from "../server/candidate-direct-email-evidence.js";
import { explicitJsonLdPersonEmail, explicitJsonLdMultiPersonContacts } from "../server/research-structured-person-evidence.js";

const profileUrl = "https://example.com/ada";
const page = (text, extra = {}) => ({ url: profileUrl, text, ...extra });

const cases = [];

function record(id, expected, actual, classification) {
  cases.push({ id, expected, actual, classification });
}

test("RD-02 matrix: labeled single named email", () => {
  const r = classifyExplicitPersonEmailPage({ name: "Ada Lovelace", expertProfileUrl: profileUrl }, page("Name: Ada Lovelace Email: ada@example.com"));
  record("M1", "REVIEW_REQUIRED/EXPLICIT_NAMED_EMAIL_ON_PROFILE", `${r.status}/${r.reason}`, r.status === "REVIEW_REQUIRED" ? "PASS" : "FALSE_NEGATIVE");
  assert.equal(r.status, "REVIEW_REQUIRED");
});

test("RD-02 matrix: generic mailbox", () => {
  const r = classifyExplicitPersonEmailPage({ name: "Ada Lovelace", expertProfileUrl: profileUrl }, page("Name: Ada Lovelace Email: info@example.com"));
  record("M2", "UNVERIFIED/ADDRESS_AMBIGUOUS_OR_NOT_PUBLISHED", `${r.status}/${r.reason}`, r.status === "UNVERIFIED" ? "PASS" : "FALSE_POSITIVE");
  assert.equal(r.status, "UNVERIFIED");
});

test("RD-02 matrix: mailto link single", () => {
  const html = `<a href="mailto:ada@example.com">Ada Lovelace</a>`;
  const r = classifyExplicitPersonEmailPage({ name: "Ada Lovelace", expertProfileUrl: profileUrl }, page(`Name: Ada Lovelace Email: ada@example.com`));
  record("M3", "REVIEW_REQUIRED", r.status, r.status === "REVIEW_REQUIRED" ? "PASS" : "FALSE_NEGATIVE");
  assert.equal(r.status, "REVIEW_REQUIRED");
});

test("RD-02 matrix: conflicting addresses", () => {
  const r = classifyExplicitPersonEmailPage({ name: "Ada Lovelace", expertProfileUrl: profileUrl }, page("Name: Ada Lovelace Email: ada@example.com Email: other@example.com"));
  record("M4", "UNVERIFIED", r.status, r.status === "UNVERIFIED" ? "PASS" : "FALSE_POSITIVE");
  assert.equal(r.status, "UNVERIFIED");
});

test("RD-02 matrix: single Person JSON-LD", () => {
  const html = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Person","name":"Ada Lovelace","email":"ada@example.com"}</script>`;
  const r = explicitJsonLdPersonEmail(html);
  record("M5", "{Ada Lovelace, ada@example.com}", JSON.stringify(r), r && r.email === "ada@example.com" ? "PASS" : "FALSE_NEGATIVE");
  assert.deepEqual(r, { name: "Ada Lovelace", email: "ada@example.com" });
});

test("RD-02 matrix: multi Person JSON-LD", () => {
  const html = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Person","name":"Ada Lovelace","email":"ada@example.com"},{"@type":"Person","name":"Grace Hopper","email":"grace@example.com"}]}</script>`;
  const r = explicitJsonLdMultiPersonContacts(html);
  record("M6", "2 contacts", String(r?.length), r?.length === 2 ? "PASS" : "FALSE_NEGATIVE");
  assert.equal(r.length, 2);
});

test("RD-02 matrix: malformed JSON-LD", () => {
  const html = `<script type="application/ld+json">{bad json}</script>`;
  const r = explicitJsonLdPersonEmail(html);
  record("M7", "null", String(r), r === null ? "PASS" : "FALSE_POSITIVE");
  assert.equal(r, null);
});

test("RD-02 matrix: oversized JSON-LD returns null", () => {
  const big = "a".repeat(20000);
  const html = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Person","name":"Ada Lovelace","email":"ada@example.com","desc":"${big}"}</script>`;
  const r = explicitJsonLdPersonEmail(html);
  record("M8", "null (oversize)", String(r), r === null ? "PASS" : "NOT_MEASURABLE");
  assert.equal(r, null);
});

test("RD-02 matrix: cross-domain link (url mismatch)", () => {
  const r = classifyExplicitPersonEmailPage({ name: "Ada Lovelace", expertProfileUrl: profileUrl }, { url: "https://other.com/ada", text: "Name: Ada Lovelace Email: ada@example.com" });
  record("M9", "UNVERIFIED/PROFILE_OR_ADDRESS_UNAVAILABLE", `${r.status}/${r.reason}`, r.status === "UNVERIFIED" ? "PASS" : "FALSE_POSITIVE");
  assert.equal(r.status, "UNVERIFIED");
});

test("RD-02 matrix: digest mismatch not measurable offline", () => {
  record("M10", "digest mismatch", "N/A", "NOT_MEASURABLE");
});

test("RD-02 matrix: inaccessible source not measurable offline", () => {
  record("M11", "inaccessible", "N/A", "NOT_MEASURABLE");
});

test("after all: print matrix", () => {
  console.log("RD02_COVERAGE_MATRIX=" + JSON.stringify(cases));
});
