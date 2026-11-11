import test from "node:test";
import assert from "node:assert/strict";
import { parseApprovedSources, parseSyndication, robotsAllowed, discoverFeed } from "../server/discovery.js";

const feedUrl = "https://example.org/feed.xml";
const xml = `<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><item><title>Building an AI workflow</title><dc:creator>Alice Example</dc:creator><link>https://example.org/articles/workflow</link></item>
<item><title>Another project</title><dc:creator>Alice Example</dc:creator><link>https://example.org/articles/another</link></item>
<item><title>Marketing trends</title><dc:creator>Bob Example</dc:creator><link>https://example.org/bob</link></item></channel></rss>`;

test("only configured HTTPS feeds can be used", () => {
  assert.deepEqual(parseApprovedSources(feedUrl + "," + feedUrl), [feedUrl]);
  for (const url of ["http://example.org/feed", "https://localhost/feed", "https://127.0.0.1/feed", "https://linkedin.com/feed", "https://user:pass@example.org/feed"]) {
    assert.throws(() => parseApprovedSources(url));
  }
});

test("RSS author entries are deduplicated without inventing email or eligibility", () => {
  const items = parseSyndication(xml, feedUrl);
  assert.equal(items.length, 2);
  assert.equal(items[0].name, "Alice Example");
  assert.equal(items[0].sourceUrl, "https://example.org/articles/workflow");
  assert.ok(items[0].discoveryKey.length === 64);
  assert.equal("email" in items[0], false);
  assert.equal("onlineEnglish" in items[0], false);
});
test("Atom author name, relative alternate link and escaped text", () => {
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Growth &amp; Strategy</title><author><name>Carol Example</name></author><link rel="alternate" href="/posts/growth"/></entry></feed>`;
  const rows = parseSyndication(atom, feedUrl);
  assert.equal(rows[0].headline, "Growth & Strategy");
  assert.equal(rows[0].sourceUrl, "https://example.org/posts/growth");
});
test("rejects XML entity declarations and unsupported body", () => {
  assert.throws(() => parseSyndication('<!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]><rss/>', feedUrl));
  assert.throws(() => parseSyndication("<html>not a feed</html>", feedUrl));
});
test("robots.txt honors specific and wildcard rules", () => {
  assert.equal(robotsAllowed("User-agent: *\nDisallow: /feed\nAllow: /feed-public", "/feed.xml"), false);
  assert.equal(robotsAllowed("User-agent: *\nDisallow: /feed\nAllow: /feed-public", "/feed-public.xml"), true);
  assert.equal(robotsAllowed("User-agent: SnapyCallPilotDiscovery\nDisallow: /", "/feed.xml"), false);
  assert.equal(robotsAllowed("User-agent: *\nDisallow: /", "/feed.xml"), false);
  assert.equal(robotsAllowed("User-agent: *\nDisallow: /private", "/feed.xml"), true);
});
test("discovery fetches only approved robots + feed URLs, never redirects", async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow: /private", { headers: { "content-type": "text/plain" } });
    return new Response(xml, { headers: { "content-type": "application/rss+xml" } });
  };
  const rows = await discoverFeed({ url: feedUrl, approvedSources: [feedUrl], fetcher });
  assert.equal(rows.length, 2);
  assert.deepEqual(calls.map((c) => c.url), ["https://example.org/robots.txt", feedUrl]);
  assert.ok(calls.every((c) => c.options.redirect === "manual"));
  await assert.rejects(() => discoverFeed({ url: "https://other.org/feed", approvedSources: [feedUrl], fetcher }), /not been approved/);
});
test("robots unavailable or denying access blocks feed processing", async () => {
  const fetcher = async () => new Response("unavailable", { status: 503, headers: { "content-type": "text/plain" } });
  await assert.rejects(() => discoverFeed({ url: feedUrl, approvedSources: [feedUrl], fetcher }));
});
