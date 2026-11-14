import test from "node:test";
import assert from "node:assert/strict";
import { manualIndependentResearch } from "../src/manual-research.js";

test("manual discovery uses independent browser search without querying the seed site", () => {
  const result = manualIndependentResearch("Ada Example", "COACHING",
    "https://professionalsus.com/profile/ada#overview");
  assert.equal(result.excludedHostname, "professionalsus.com");
  assert.match(result.criteria, /"Ada Example"/);
  assert.match(result.criteria, /-site:professionalsus\.com/);
  assert.equal(new URL(result.searchUrl).hostname, "www.google.com");
  assert.equal(new URL(result.searchUrl).searchParams.get("q"), result.criteria);
});

test("research handoff never infers contact data, qualifications or authorization", () => {
  const result = manualIndependentResearch("  Jane Doe ", "AI_AUTOMATION",
    "https://experts.example.org/jane");
  assert.deepEqual(Object.keys(result).sort(),
    ["criteria", "excludedHostname", "searchUrl"]);
  assert.equal(result.criteria.includes("jane@"), false);
  assert.equal(result.criteria.includes("consent"), false);
  assert.equal(result.criteria.includes("site:experts.example.org"),
    true);
});

test("manual lookup query construction rejects unsupported inputs and local origins", () => {
  for (const [name, category, url] of [
    ["", "COACHING", "https://example.org"],
    ["Jane", "SECRET", "https://example.org"],
    ["Jane", "COACHING", "http://example.org"],
    ["Jane", "COACHING", "https://user:pass@example.org"],
    ["Jane", "COACHING", "https://localhost/"],
    ["Jane", "COACHING", "https://example.org:9000/"],
  ]) assert.throws(() => manualIndependentResearch(name, category, url));
});
