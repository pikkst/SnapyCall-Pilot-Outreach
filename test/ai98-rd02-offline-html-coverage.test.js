import test from "node:test";
import assert from "node:assert/strict";
import { classifyExplicitPersonEmailPage } from "../server/candidate-direct-email-evidence.js";
import { explicitJsonLdPersonEmail, explicitJsonLdMultiPersonContacts } from "../server/research-structured-person-evidence.js";
import { inspectNamedPublicContactEvidence } from "../server/research-linked-contact-proof.js";

const profileUrl = "https://example.com/ada";

const measured = [];
const unmeasured = ["F3", "F4", "F8", "F11"];

test("RD-02 declarative fixture evaluation", async () => {
  const fixtures = [
    { id: "F1", name: "Ada Lovelace", pageText: "Name: Ada Lovelace Email: ada@example.com", expectedStatus: "REVIEW_REQUIRED", expectedReason: "EXPLICIT_NAMED_EMAIL_ON_PROFILE" },
    { id: "F2", name: "Ada Lovelace", pageText: "Name: Ada Lovelace Email: info@example.com", expectedStatus: "UNVERIFIED", expectedReason: "ADDRESS_AMBIGUOUS_OR_NOT_PUBLISHED" },
    { id: "F5", html: '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Person","name":"Ada Lovelace","email":"ada@example.com"}</script>', expectedJson: { name: "Ada Lovelace", email: "ada@example.com" } },
    { id: "F6", html: '<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Person","name":"Ada Lovelace","email":"ada@example.com"},{"@type":"Person","name":"Grace Hopper","email":"grace@example.com"}]}</script>', expectedCount: 2 },
    { id: "F7", html: '<script type="application/ld+json">{bad}</script>', expectedJson: null },
  ];

  for (const f of fixtures) {
    if (f.pageText) {
      const r = classifyExplicitPersonEmailPage({ name: f.name, expertProfileUrl: profileUrl }, { url: profileUrl, text: f.pageText });
      const match = r.status === f.expectedStatus && r.reason === f.expectedReason;
      measured.push({ id: f.id, expected: { status: f.expectedStatus, reason: f.expectedReason }, actual: { status: r.status, reason: r.reason }, match });
      assert.equal(r.status, f.expectedStatus, `${f.id} status`);
      assert.equal(r.reason, f.expectedReason, `${f.id} reason`);
    } else if (f.expectedJson !== undefined && f.expectedCount === undefined) {
      const r = explicitJsonLdPersonEmail(f.html);
      const match = JSON.stringify(r) === JSON.stringify(f.expectedJson);
      measured.push({ id: f.id, expected: f.expectedJson, actual: r, match });
      assert.deepEqual(r, f.expectedJson, `${f.id} json`);
    } else if (f.expectedCount !== undefined) {
      const r = explicitJsonLdMultiPersonContacts(f.html);
      const match = (r?.length ?? null) === f.expectedCount;
      measured.push({ id: f.id, expected: f.expectedCount, actual: r?.length ?? null, match });
      assert.equal(r?.length, f.expectedCount, `${f.id} count`);
    }
  }

  const retrievePos = async (u) => u === profileUrl
    ? { url: profileUrl, text: "Name: Ada Lovelace", linkedContactUrl: "https://example.com/contact" }
    : { url: "https://example.com/contact", text: "Name: Ada Lovelace Email: ada@example.com" };
  const rPos = await inspectNamedPublicContactEvidence({ url: profileUrl, name: "Ada Lovelace", retrieve: retrievePos });
  const matchPos = !!rPos.evidence;
  measured.push({ id: "F9", expected: "evidence", actual: rPos.evidence ? "evidence" : "null", match: matchPos });
  assert.ok(rPos.evidence);

  const retrieveNeg = async (u) => u === profileUrl
    ? { url: profileUrl, text: "Name: Ada Lovelace", linkedContactUrl: "https://example.com/contact" }
    : (() => { throw new Error("unavailable"); })();
  const rNeg = await inspectNamedPublicContactEvidence({ url: profileUrl, name: "Ada Lovelace", retrieve: retrieveNeg });
  const matchNeg = rNeg.linkedUnavailable === true;
  measured.push({ id: "F10", expected: "linkedUnavailable=true", actual: String(rNeg.linkedUnavailable), match: matchNeg });
  assert.equal(rNeg.linkedUnavailable, true);

  const mismatches = measured.filter(r => !r.match);
  const fp = mismatches.filter(r => r.actual?.status === "REVIEW_REQUIRED" && r.expected?.status !== "REVIEW_REQUIRED").length;
  const fn = mismatches.filter(r => r.actual?.status !== "REVIEW_REQUIRED" && r.expected?.status === "REVIEW_REQUIRED").length;
  console.log("RD02_MEASURED=" + JSON.stringify(measured));
  console.log("RD02_UNMEASURED=" + JSON.stringify(unmeasured));
  console.log(`RD02_SUMMARY measured=${measured.length} unmeasured=${unmeasured.length} mismatches=${mismatches.length} FP=${fp} FN=${fn}`);
  assert.equal(mismatches.length, 0);
});
