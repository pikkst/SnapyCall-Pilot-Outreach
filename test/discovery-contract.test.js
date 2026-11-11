import test from "node:test";
import assert from "node:assert/strict";
import { discoveryKeyFor } from "../server/discovery.js";

test("import key is stable for repeated scans, independent of case", () => {
  const feed = "https://example.org/feed";
  assert.equal(discoveryKeyFor(feed, "Alice Example"), discoveryKeyFor(feed, "alice example "));
  assert.notEqual(discoveryKeyFor(feed, "Alice Example"), discoveryKeyFor(feed, "Bob Example"));
});
