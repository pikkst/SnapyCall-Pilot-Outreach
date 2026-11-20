import test from "node:test";
import assert from "node:assert/strict";
import { classifyExplicitPersonEmailPage } from "../server/candidate-direct-email-evidence.js";
import { explicitJsonLdPersonEmail, explicitJsonLdMultiPersonContacts } from "../server/research-structured-person-evidence.js";
import { inspectNamedPublicContactEvidence } from "../server/research-linked-contact-proof.js";

const profileUrl = "https://example.com/ada";

const cases = [];

function record(id, expected, actual, classification) {
  cases.push({ id, expected, actual, classification });
}

test("RD-02 M1 labeled single named email", () => {
  const r = classifyExplicitPersonEmailPage({ name: "Ada Lovelace", expertProfileUrl: profileUrl }, { url: profileUrl, text: "Name: Ada Lovelace Email: ada@example.com" });
  record("M1", "REVIEW_REQUIRED", r.status, r.status === "REVIEW_REQUIRED" ? "PASS" : "FALSE_NEGATIVE");
  assert.equal(r.status, "REVIEW_REQUIRED");
});

test("RD-02 M2 generic mailbox", () => {
  const r = classifyExplicitPersonEmailPage({ name: "Ada Lovelace", expertProfileUrl: profileUrl }, { url: profileUrl, text: "Name: Ada Lovelace Email: info@example.com" });
  record("M2", "UNVERIFIED", r.status, r.status === "UNVERIFIED" ? "PASS" : "FALSE_POSITIVE");
  assert.equal(r.status, "UNVERIFIED");
});

test("RD-02 M3 visible mailto anchor text", () => {
  const r = classifyExplicitPersonEmailPage({ name: "Ada Lovelace", expertProfileUrl: profileUrl }, { url: profileUrl, text: "Name: Ada Lovelace Email: ada@example.com (mailto:ada@example.com)" });
  record("M3", "REVIEW_REQUIRED", r.status, r.status === "REVIEW_REQUIRED" ? "PASS" : "FALSE_NEGATIVE");
  assert.equal(r.status, "REVIEW_REQUIRED");
});

test("RD-02 M4 conflicting addresses", () => {
  const r = classifyExplicitPersonEmailPage({ name: "Ada Lovelace", expertProfileUrl: profileUrl }, { url: profileUrl, text: "Name: Ada Lovelace Email: ada@example.com Email: other@example.com" });
  record("M4", "UNVERIFIED", r.status, r.status === "UNVERIFIED" ? "PASS" : "FALSE_POSITIVE");
  assert.equal(r.status, "UNVERIFIED");
});

test("RD-02 M5 single Person JSON-LD", () => {
  const html = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Person","name":"Ada Lovelace","email":"ada@example.com"}</script>`;
  const r = explicitJsonLdPersonEmail(html);
  record("M5", "object", typeof r, r && r.email === "ada@example.com" ? "PASS" : "FALSE_NEGATIVE");
  assert.deepEqual(r, { name: "Ada Lovelace", email: "ada@example.com" });
});

test("RD-02 M6 multi Person JSON-LD", () => {
  const html = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Person","name":"Ada Lovelace","email":"ada@example.com"},{"@type":"Person","name":"Grace Hopper","email":"grace@example.com"}]}</script>`;
  const r = explicitJsonLdMultiPersonContacts(html);
  record("M6", "2", String(r?.length), r?.length === 2 ? "PASS" : "FALSE_NEGATIVE");
  assert.equal(r.length, 2);
});

test("RD-02 M7 malformed JSON-LD", () => {
  const r = explicitJsonLdPersonEmail(`<script type="application/ld+json">{bad}</script>`);
  record("M7", "null", String(r), r === null ? "PASS" : "FALSE_POSITIVE");
  assert.equal(r, null);
});

test("RD-02 M8 oversized JSON-LD", () => {
  const big = "a".repeat(20000);
  const r = explicitJsonLdPersonEmail(`<script type="application/ld+json">{"@context":"https://schema.org","@type":"Person","name":"Ada Lovelace","email":"ada@example.com","desc":"${big}"}</script>`);
  record("M8", "null", String(r), r === null ? "PASS" : "NOT_MEASURABLE");
  assert.equal(r, null);
});

test("RD-02 M9 cross-domain link", () => {
  const r = classifyExplicitPersonEmailPage({ name: "Ada Lovelace", expertProfileUrl: profileUrl }, { url: "https://other.com/ada", text: "Name: Ada Lovelace Email: ada@example.com" });
  record("M9", "UNVERIFIED", r.status, r.status === "UNVERIFIED" ? "PASS" : "FALSE_POSITIVE");
  assert.equal(r.status, "UNVERIFIED");
});

test("RD-02 M10 linked contact offline positive", async () => {
  const retrieve = async (u) => u === profileUrl
    ? { url: profileUrl, text: "Name: Ada Lovelace", linkedContactUrl: "https://example.com/contact" }
    : { url: "https://example.com/contact", text: "Name: Ada Lovelace Email: ada@example.com" };
  const r = await inspectNamedPublicContactEvidence({ url: profileUrl, name: "Ada Lovelace", retrieve });
  record("M10", "evidence", r.evidence ? "evidence" : "null", r.evidence ? "PASS" : "FALSE_NEGATIVE");
  assert.ok(r.evidence);
});

test("RD-02 M11 linked contact unavailable boundary", async () => {
  const retrieve = async (u) => u === profileUrl
    ? { url: profileUrl, text: "Name: Ada Lovelace", linkedContactUrl: "https://example.com/contact" }
    : (() => { throw new Error("unavailable"); })();
  const r = await inspectNamedPublicContactEvidence({ url: profileUrl, name: "Ada Lovelace", retrieve });
  record("M11", "linkedUnavailable=true", String(r.linkedUnavailable), r.linkedUnavailable ? "PASS" : "FALSE_NEGATIVE");
  assert.equal(r.linkedUnavailable, true);
});

test("RD-02 M12 digest/readback boundary documented", () => {
  record("M12", "NOT_MEASURABLE", "NOT_MEASURABLE", "NOT_MEASURABLE");
});

test("RD-02 print matrix", () => {
  console.log("RD02_COVERAGE_MATRIX=" + JSON.stringify(cases));
  const fp = cases.filter(c => c.classification === "FALSE_POSITIVE").length;
  const fn = cases.filter(c => c.classification === "FALSE_NEGATIVE").length;
  assert.equal(fp, 0);
  assert.equal(fn, 0);
});
