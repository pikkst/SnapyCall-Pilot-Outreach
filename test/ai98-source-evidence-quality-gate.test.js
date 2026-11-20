import test from "node:test";
import assert from "node:assert/strict";
import { rankCitedPersonSourceUrls, inspectEvidenceBackedPersonSources }
  from "../server/research-person-source-executor.js";

test("exact-person contact hints are inspected before generic news on same approved budget", () => {
  const urls = [
    "https://example.org/news/ada-lovelace",
    "https://example.org/people/ada-lovelace",
    "https://example.org/team/ada-lovelace",
    "https://example.org/blog/ada-lovelace",
  ];
  assert.deepEqual(rankCitedPersonSourceUrls(urls, "Ada Lovelace"), [
    urls[2], urls[1], urls[0], urls[3],
  ]);
  assert.deepEqual(urls, [
    "https://example.org/news/ada-lovelace",
    "https://example.org/people/ada-lovelace",
    "https://example.org/team/ada-lovelace",
    "https://example.org/blog/ada-lovelace",
  ]);
});

test("cold-start citations preserve order and identity is never inferred from a host", () => {
  const urls = ["https://site-one.example.org/", "https://site-two.example.org/"];
  assert.deepEqual(rankCitedPersonSourceUrls(urls, "Ada Lovelace"), urls);
  assert.throws(() => rankCitedPersonSourceUrls(
    ["http://example.org/team/ada-lovelace"], "Ada Lovelace"), TypeError);
  assert.throws(() => rankCitedPersonSourceUrls(
    Array(6).fill("https://example.org/"), "Ada Lovelace"), TypeError);
});

test("ranked source hints still require independent retrieval and never become qualified email proof", async () => {
  const candidate = (url) => ({
    name: "Ada Lovelace", category: "AI_AUTOMATION", citationUrl: url,
    rationale: "Exact professional cited profile",
  });
  const urls = [
    "https://example.org/news/ada-lovelace",
    "https://example.org/team/ada-lovelace",
  ];
  const checked = [];
  const result = await inspectEvidenceBackedPersonSources({
    observations: urls.map(candidate),
    sources: urls.map(url => ({ url })),
  }, { name: "Ada Lovelace", category: "AI_AUTOMATION" }, {
    retrieve: async url => {
      checked.push(url);
      return { url, text: "Ada Lovelace is a consultant." };
    },
    mayFollowLinked: () => false,
  });
  assert.deepEqual(checked, [urls[1], urls[0]]);
  assert.equal(result.proposedUrl, null);
  assert.equal(result.diagnostics.verified, 0);
});
