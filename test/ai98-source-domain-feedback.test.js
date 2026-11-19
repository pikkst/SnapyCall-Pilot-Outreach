import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repeatedUnavailableSourceDomains }
  from "../server/research-source-domain-feedback.js";
import { buildBoundedTavilySearchRequest }
  from "../server/research-provider-adapters.js";

const unavailable = url => ({
  status: "SOURCE_UNAVAILABLE", proposedSourceUrl: url,
});
const other = url => ({
  status: "SOURCE_NOT_ATTRIBUTABLE", proposedSourceUrl: url,
});

test("two independently settled unavailable sources exclude a domain without a static denylist", () => {
  const urls = [
    unavailable("https://www.example.org/first"),
    unavailable("https://example.org/second"),
    unavailable("https://profiles.example.net/name"),
    other("https://profiles.example.net/other"),
    unavailable("https://site.example.com/person"),
    unavailable("https://site.example.com/contact"),
    unavailable("https://solo.example.io/person"),
  ];
  const excluded = repeatedUnavailableSourceDomains(urls);
  assert.deepEqual(excluded, ["example.org", "site.example.com"]);
  assert.equal(excluded.includes("profiles.example.net"), false);
  assert.equal(excluded.includes("solo.example.io"), false);
});

test("unsafe/malformed or non-public URL observations never become provider domain filters", () => {
  const records = [
    unavailable("http://example.org/a"),
    unavailable("https://localhost/a"),
    unavailable("https://127.0.0.1/a"),
    unavailable("https://user:password@example.org/a"),
    unavailable("https://example.org:8443/a"),
    unavailable("https://www.exam-ple.org/a"),
    unavailable("https://www.exam-ple.org/b"),
    unavailable("not-a-url"),
    unavailable("https://co.uk/a"),
  ];
  const result = repeatedUnavailableSourceDomains(records);
  assert.deepEqual(result, ["exam-ple.org"]);
  assert.throws(() => repeatedUnavailableSourceDomains(Array(251).fill(records[0])));
  assert.throws(() => repeatedUnavailableSourceDomains(records, { minFailures: 1 }));
});

test("Tavily Basic applies only validated bounded exclusions, never changes default discovery request", () => {
  const input = { query: '"Ada Lovelace" official public biography contact',
    maxResults: 5 };
  const base = buildBoundedTavilySearchRequest(input);
  assert.equal(base.search_depth, "basic");
  assert.equal(base.exclude_domains, undefined);
  const filtered = buildBoundedTavilySearchRequest({
    ...input, excludeDomains: ["example.org", "site.example.com"],
  });
  assert.deepEqual(filtered.exclude_domains,
    ["example.org", "site.example.com"]);
  assert.equal(Object.isFrozen(filtered.exclude_domains), true);
  assert.throws(() => buildBoundedTavilySearchRequest({
    ...input, excludeDomains: ["example.org", "example.org"],
  }));
  for (const domain of ["localhost", "example.org/path", "-site:evil.org",
    "http://example.org", "EXAMPLE.ORG", "foo\\bar.com"]) {
    assert.throws(() => buildBoundedTavilySearchRequest({
      ...input, excludeDomains: [domain],
    }));
  }
});

test("source-only domain feedback is scoped to a claimed campaign and does not authorize new calls", () => {
  const executor = readFileSync(
    new URL("../server/research-person-source-executor.js", import.meta.url),
    "utf8");
  const ai = readFileSync(new URL("../server/ai-research.js", import.meta.url),
    "utf8");
  const adapter = readFileSync(
    new URL("../server/research-provider-adapters.js", import.meta.url),
    "utf8");
  const start = executor.indexOf("let excludeDomains = [];");
  const end = executor.indexOf("result = await plan.search", start);
  assert.ok(start >= 0 && end > start);
  const scoped = executor.slice(start, end);
  assert.match(scoped, /campaignId, status: "SOURCE_UNAVAILABLE"/);
  assert.match(scoped, /take: 250/);
  assert.match(scoped, /repeatedUnavailableSourceDomains\(previous\)/);
  assert.match(executor, /sourceSubject: \{ name: claim.name, category: claim.category \},\s*excludeDomains/);
  assert.match(ai, /maxInputTokens, sourceSubject, excludeDomains/);
  assert.match(adapter, /query, maxResults, observedAt, apiKey: tavilyApiKey, excludeDomains/);
  assert.doesNotMatch(scoped, /reserveOwnerSpend|runOnePersonSourceJob|createMany|updateMany/);
});
