import test from "node:test";
import assert from "node:assert/strict";
import { inspectEvidenceBackedPersonSources, finishPersonSourceJob }
  from "../server/research-person-source-executor.js";

const person = { name: "Ada Lovelace", category: "AI_AUTOMATION" };
const urls = ["https://example.org/ada", "https://example.net/ada",
  "https://example.com/ada"];
const input = (list = urls) => ({
  candidates: list.map(sourceUrl => ({
    ...person, sourceUrl, rationale: "Published professional profile information",
  })),
  sources: list.map(url => ({ url, title: "Professional biography" })),
});
const page = (url, email = "ada@example.org") => ({
  url, text: "Name: Ada Lovelace Email: " + email,
});

test("no cited target produces a precise no-source outcome without fetching", async () => {
  const result = await inspectEvidenceBackedPersonSources({
    candidates: [], sources: [],
  }, person, { retrieve: () => { throw new Error("Unexpected fetch"); } });
  assert.equal(result.proposedUrl, null);
  assert.deepEqual(result.diagnostics, {
    cited: 0, attempted: 0, unavailable: 0, noNamedEmail: 0,
    verified: 0, conflicting: false,
    reason: "SOURCE_NO_MATCHING_CITED_PROFILE",
  });
});

test("all blocked sources are counted without treating refusal as no email", async () => {
  const outcome = await inspectEvidenceBackedPersonSources(input(), person, {
    retrieve: async () => { throw new Error("PUBLIC_PAGE_ROBOTS_REJECTED"); },
  });
  assert.equal(outcome.proposedUrl, null);
  assert.equal(outcome.diagnostics.attempted, 3);
  assert.equal(outcome.diagnostics.unavailable, 3);
  assert.equal(outcome.diagnostics.noNamedEmail, 0);
  assert.equal(outcome.diagnostics.reason, "SOURCE_ALL_PAGES_UNAVAILABLE");
});

test("readable nonattributable sources remain distinct from inaccessible ones", async () => {
  const result = await inspectEvidenceBackedPersonSources(input(urls.slice(0, 2)),
    person, { retrieve: async url => ({ url, text: "Contact: info@example.org" }) });
  assert.equal(result.proposedUrl, null);
  assert.equal(result.diagnostics.reason, "SOURCE_NO_NAMED_EMAIL_EVIDENCE");
  assert.equal(result.diagnostics.noNamedEmail, 2);
});

test("mixed access and attribution failures are explicit", async () => {
  const outcome = await inspectEvidenceBackedPersonSources(input(urls.slice(0, 2)),
    person, { retrieve: async url => {
      if (url === urls[0]) throw new Error("PUBLIC_PAGE_TIMEOUT");
      return { url, text: "Biography without a named mailbox" };
    } });
  assert.equal(outcome.diagnostics.reason, "SOURCE_MIXED_UNQUALIFIED");
  assert.equal(outcome.diagnostics.unavailable, 1);
  assert.equal(outcome.diagnostics.noNamedEmail, 1);
});

test("matching explicit personal evidence returns one URL, never email in telemetry", async () => {
  const outcome = await inspectEvidenceBackedPersonSources(input(urls.slice(0, 2)),
    person, { retrieve: async url => page(url) });
  assert.equal(outcome.proposedUrl, urls[0]);
  assert.equal(outcome.diagnostics.verified, 2);
  assert.equal(outcome.diagnostics.reason, "SOURCE_NAMED_EMAIL_SOURCE_SELECTED");
  assert.doesNotMatch(JSON.stringify(outcome.diagnostics), /ada@|https:|Lovelace/);
});

test("contradictory independently verified email evidence fails closed", async () => {
  const result = await inspectEvidenceBackedPersonSources(input(urls.slice(0, 2)),
    person, { retrieve: async url =>
      page(url, url === urls[0] ? "ada@example.org" : "ada@example.net") });
  assert.equal(result.proposedUrl, null);
  assert.equal(result.diagnostics.reason, "SOURCE_CONFLICTING_PERSON_EMAILS");
  assert.equal(result.diagnostics.conflicting, true);
});

test("more than three cited sources cannot cause an unbounded inspection", async () => {
  const list = [...urls, "https://example.edu/ada", "https://example.io/ada"];
  let visits = 0;
  const result = await inspectEvidenceBackedPersonSources(input(list),
    person, { retrieve: async url => { visits++; return { url, text: "" }; } });
  assert.equal(visits, 3);
  assert.equal(result.diagnostics.attempted, 3);
});

test("malformed inspection metadata is rejected before any database work", async () => {
  const scope = {
    campaignId: "cmabcdefghijklmnopqrstu",
    workspaceId: "cmabcdefghijklmnopqrstv",
    ownerId: "cmabcdefghijklmnopqrstw",
    jobId: "cmabcdefghijklmnopqrs2",
    leaseToken: "fence", reservationId: "reserve",
  };
  for (const inspection of [
    { cited: 99, attempted: 99, unavailable: 0, noNamedEmail: 0,
      verified: 0, conflicting: false, reason: "SOURCE_NO_MATCHING_CITED_PROFILE" },
    { cited: 1, attempted: 1, unavailable: 0, noNamedEmail: 0,
      verified: 0, conflicting: false, reason: "SOURCE_NO_MATCHING_CITED_PROFILE" },
    { cited: 0, attempted: 0, unavailable: 0, noNamedEmail: 0,
      verified: 0, conflicting: false, reason: "ARBITRARY_RAW_ERROR", email: "x@y.io" },
  ]) {
    await assert.rejects(finishPersonSourceJob({
      $transaction: () => { throw new Error("Unexpected database access"); },
    }, scope, { inspection }), TypeError);
  }
});
