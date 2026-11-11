import test from "node:test";
import assert from "node:assert/strict";
import { parseApprovedSources, parseSyndication, robotsAllowed, discoverFeed, DiscoverySourceError, normalizeFeedAuthor, discoveryKeyFor } from "../server/discovery.js";

const feedUrl = "https://example.org/feed.xml";
const xml = `<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><item><title>Building an AI workflow</title><dc:creator>Alice Example</dc:creator><link>https://example.org/articles/workflow</link></item>
<item><title>Another project</title><dc:creator>Alice Example</dc:creator><link>https://example.org/articles/another</link></item>
<item><title>Marketing trends</title><dc:creator>Bob Example</dc:creator><link>https://example.org/bob</link></item></channel></rss>`;

test("only configured HTTPS feeds can be used", () => {
  assert.deepEqual(parseApprovedSources(feedUrl + "," + feedUrl), [feedUrl]);
  for (const url of ["http://example.org/feed", "https://localhost/feed", "https://127.0.0.1/feed", "https://linkedin.com/feed", "https://community.n8n.io/latest.rss", "https://community.make.com/latest.rss", "https://www.consultingsuccess.com/feed", "https://user:pass@example.org/feed"]) {
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

test("upstream robots failure is classified without fetching the feed", async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    return new Response("unavailable", { status: 503, headers: { "content-type": "text/plain" } });
  };
  await assert.rejects(
    discoverFeed({ url: feedUrl, approvedSources: [feedUrl], fetcher }),
    (error) => error instanceof DiscoverySourceError && error.code === "SOURCE_UPSTREAM_ERROR" && error.stage === "robots",
  );
  assert.deepEqual(calls, ["https://example.org/robots.txt"]);
});
test("upstream timeout reports stage and status without disclosing fetch error", async () => {
  const fetcher = async () => { throw new DOMException("sensitive-provider-details", "TimeoutError"); };
  await assert.rejects(
    discoverFeed({ url: feedUrl, approvedSources: [feedUrl], fetcher }),
    (error) => error.code === "SOURCE_TIMEOUT" && error.status === 504 && error.stage === "robots" &&
      !error.message.includes("sensitive-provider-details"),
  );
});
test("feed redirect remains blocked and is not followed", async () => {
  const fetcher = async (url) => url.endsWith("/robots.txt")
    ? new Response("User-agent: *\\nAllow: /", { headers: { "content-type": "text/plain" } })
    : new Response(null, { status: 302, headers: { location: "https://other.example/feed" } });
  await assert.rejects(
    discoverFeed({ url: feedUrl, approvedSources: [feedUrl], fetcher }),
    (error) => error.code === "SOURCE_REDIRECT_BLOCKED" && error.stage === "feed",
  );
});
test("invalid feed response reports distinct content type and format errors", async () => {
  const robots = new Response("User-agent: *\\nAllow: /", { headers: { "content-type": "text/plain" } });
  const badContentType = async (url) => url.endsWith("/robots.txt") ? robots.clone()
    : new Response("<html>not a feed</html>", { headers: { "content-type": "application/json" } });
  await assert.rejects(
    discoverFeed({ url: feedUrl, approvedSources: [feedUrl], fetcher: badContentType }),
    (error) => error.code === "SOURCE_INVALID_CONTENT_TYPE" && error.stage === "feed",
  );
  const badFeed = async (url) => url.endsWith("/robots.txt") ? robots.clone()
    : new Response("<html>not a feed</html>", { headers: { "content-type": "application/xml" } });
  await assert.rejects(
    discoverFeed({ url: feedUrl, approvedSources: [feedUrl], fetcher: badFeed }),
    (error) => error.code === "SOURCE_INVALID_FEED" && error.stage === "feed",
  );
});


test("bounded scanner accepts a valid 300 KiB feed above previous 250 KB limit", async () => {
  const article = "A".repeat(310_000);
  const largeFeed = `<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
    <channel><item><title>Automation notes</title><dc:creator>Alice Example</dc:creator>
    <link>https://example.org/alice</link><description>${article}</description></item></channel></rss>`;
  assert.ok(Buffer.byteLength(largeFeed, "utf8") > 250_000);
  const fetcher = async (url) => url.endsWith("/robots.txt")
    ? new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } })
    : new Response(largeFeed, { headers: { "content-type": "application/rss+xml" } });
  const candidates = await discoverFeed({ url: feedUrl, approvedSources: [feedUrl], fetcher });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].name, "Alice Example");
  assert.equal(candidates[0].sourceUrl, "https://example.org/alice");
});

test("oversized RSS content-length is rejected before reading the body", async () => {
  const fetcher = async (url) => url.endsWith("/robots.txt")
    ? new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } })
    : new Response("not a feed", { headers: { "content-type": "application/rss+xml", "content-length": String(3 * 1024 * 1024) } });
  await assert.rejects(
    discoverFeed({ url: feedUrl, approvedSources: [feedUrl], fetcher }),
    (error) => error.code === "SOURCE_TOO_LARGE" && error.stage === "feed",
  );
});

test("oversized streamed RSS without content-length fails with bounded read", async () => {
  const chunk = new Uint8Array(256 * 1024);
  let pulls = 0;
  const fetcher = async (url) => url.endsWith("/robots.txt")
    ? new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } })
    : new Response(new ReadableStream({
      pull(controller) {
        pulls++;
        controller.enqueue(chunk);
        if (pulls >= 12) controller.close();
      },
    }), { headers: { "content-type": "application/rss+xml" } });
  await assert.rejects(
    discoverFeed({ url: feedUrl, approvedSources: [feedUrl], fetcher }),
    (error) => error.code === "SOURCE_TOO_LARGE" && error.stage === "feed",
  );
  assert.ok(pulls <= 12);
});

test("XML parser applies UTF-8 byte cap rather than JavaScript character count", () => {
  const multibyte = "ü".repeat(1_200_000);
  assert.ok(multibyte.length < 2 * 1024 * 1024);
  assert.ok(Buffer.byteLength(multibyte, "utf8") > 2 * 1024 * 1024);
  assert.throws(() => parseSyndication("<rss><channel>" + multibyte + "</channel></rss>", feedUrl), /Unsafe or oversized feed/);
});

test("single-item Python-list bylines are normalized while keeping stable legacy import identity", () => {
  const sample = `<rss xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>
    <item><title>Automation article</title><dc:creator>['TimidRobot']</dc:creator>
    <link>https://example.org/article</link></item>
  </channel></rss>`;
  const [entry] = parseSyndication(sample, feedUrl);
  assert.equal(entry.name, "TimidRobot");
  assert.equal(entry.discoveryKey, discoveryKeyFor(feedUrl, "['TimidRobot']"));
  assert.equal(normalizeFeedAuthor("['TimidRobot']"), "TimidRobot");
  assert.equal(normalizeFeedAuthor('["Sara Example"]'), "Sara Example");
  assert.equal(normalizeFeedAuthor("['Alice', 'Bob']"), "['Alice', 'Bob']");
  assert.equal(normalizeFeedAuthor("O'Reilly"), "O'Reilly");
  assert.equal(normalizeFeedAuthor("['unfinished'"), "['unfinished'");
});
