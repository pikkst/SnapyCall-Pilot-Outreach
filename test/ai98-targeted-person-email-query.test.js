import test from "node:test";
import assert from "node:assert/strict";
import { personSourceSearchQuery } from "../server/research-person-source-executor.js";
import { buildBoundedTavilySearchRequest }
  from "../server/research-provider-adapters.js";

// Offline comparison: these are synthetic observations, not live results.
// Search retrieval quality cannot be inferred without a separately approved
// provider-backed A/B run. Building requests does not invoke a provider.
const savedCases = [
  { name: "Ada Lovelace", category: "AI_AUTOMATION" },
  { name: "Grace Hopper", category: "COACHING" },
  { name: "Jordan Smith", category: "MARKETING_GROWTH" },
  { name: "Taylor Example", category: "BUSINESS_STRATEGY" },
];
const previous = Object.freeze({
  AI_AUTOMATION: "AI automation consultant",
  COACHING: "professional coach",
  MARKETING_GROWTH: "marketing growth consultant",
  BUSINESS_STRATEGY: "business strategy consultant",
});

test("offline replay replaces broad profile intent with person-email intent", () => {
  for (const subject of savedCases) {
    const oldQuery = '"' + subject.name + '" ' +
      previous[subject.category] +
      " official website professional bio public contact";
    const query = personSourceSearchQuery(subject);
    assert.notEqual(query, oldQuery);
    assert.ok(query.startsWith('"' + subject.name + '" '));
    assert.match(query, /email contact/);
    assert.match(query, /official$/);
    const request = buildBoundedTavilySearchRequest({
      query, maxResults: 5,
    });
    assert.equal(request.query, query);
    assert.equal(request.search_depth, "basic");
    assert.ok(query.length <= 350);
  }
});

test("quotes, repeated spaces and injected newline cannot change search envelope", () => {
  const query = personSourceSearchQuery({
    name: '  Ada "Countess"   Lovelace ', category: "AI_AUTOMATION",
  });
  assert.equal(query, '"Ada Countess Lovelace" email contact AI automation consultant official');
  assert.throws(() => personSourceSearchQuery({
    name: "Ada Lovelace\nsite:evil.example", category: "AI_AUTOMATION",
  }), TypeError);
  assert.throws(() => personSourceSearchQuery({
    name: "Ada Lovelace", category: "UNREVIEWED",
  }), TypeError);
});

test("one deterministic request contains no guessed mailbox or organization", () => {
  for (const subject of savedCases) {
    const first = personSourceSearchQuery(subject);
    assert.equal(first, personSourceSearchQuery({ ...subject }));
    assert.doesNotMatch(first, /@|mailto:|site:|filetype:|https?:/);
  }
});
