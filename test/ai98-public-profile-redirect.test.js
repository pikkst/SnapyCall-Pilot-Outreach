import test from "node:test";
import assert from "node:assert/strict";
import { retrieveCitedPublicPage, canonicalPublicProfileRedirect }
  from "../server/research-public-pages.js";
import { classifyExplicitPersonEmailPage }
  from "../server/candidate-direct-email-evidence.js";

const cited = "https://experts.example.org/ada";
const emailPage =
  '<h1>Ada Lovelace</h1><a href="mailto:ada@example.org">Email</a>';
const robots = { status: 404, contentType: "text/plain",
  contentEncoding: "", body: "" };

function fixture({ location = "/ada/", secondStatus = 200,
  policy = robots, resolver = async () => [
    { address: "8.8.8.8", family: 4 },
  ] } = {}) {
  const calls = [];
  const reader = () => retrieveCitedPublicPage(cited, {
    resolve: async (host, options) => {
      calls.push("DNS " + host);
      return resolver(host, options);
    },
    request: async (url, pinnedAddress) => {
      const name = String(url);
      calls.push("GET " + name + " " + pinnedAddress);
      if (name.endsWith("/robots.txt")) return policy;
      if (name === cited) return {
        status: 301, location,
      };
      return secondStatus === 200 ? {
        status: 200, contentType: "text/html; charset=utf-8",
        contentEncoding: "", body: emailPage,
      } : { status: secondStatus, location: "/ada/further" };
    },
  });
  return { calls, reader };
}

test("one same-site canonical redirect rechecks robots and pinned DNS before review-only evidence", async () => {
  const f = fixture();
  const page = await f.reader();
  assert.equal(page.url, cited, "original provider-cited URL remains source identity");
  const evidence = classifyExplicitPersonEmailPage({
    name: "Ada Lovelace", expertProfileUrl: cited, email: null,
  }, page);
  assert.equal(evidence.status, "REVIEW_REQUIRED");
  assert.equal(evidence.emailNormalized, "ada@example.org");
  assert.equal(evidence.usableAsContact, false);
  assert.equal(f.calls.length, 8);
  assert.deepEqual(f.calls.filter(x => x.includes("/robots.txt")).length, 2);
  assert.deepEqual(f.calls.filter(x => x.startsWith("DNS")).length, 4);
});

test("www/apex canonical redirects are allowed but revalidated independently", async () => {
  assert.equal(canonicalPublicProfileRedirect(cited,
    "https://www.experts.example.org/ada/"),
  "https://www.experts.example.org/ada/");
  const f = fixture({ location: "https://www.experts.example.org/ada/" });
  const page = await f.reader();
  assert.equal(page.url, cited);
  assert.ok(f.calls.some(x => x === "DNS www.experts.example.org"));
  assert.ok(f.calls.some(x => x.includes("https://www.experts.example.org/robots.txt")));
});

test("unsafe, external, non-HTTPS or credential-bearing redirects fail without fetching the target", async () => {
  for (const target of [
    "https://other.example.org/profile",
    "https://evil.org/ada",
    "http://experts.example.org/ada/",
    "https://user:password@experts.example.org/ada/",
    "https://127.0.0.1/ada",
    "//another.example.org/ada",
    "https://experts.example.org:8443/ada/",
    "mailto:ada@example.org",
    "/ada", // same URL is a redirect loop, not another useful inspection
    "",
  ]) {
    const f = fixture({ location: target });
    await assert.rejects(f.reader(), /PUBLIC_PAGE_REDIRECT_REJECTED/, target);
    assert.equal(f.calls.filter(x => x.startsWith("GET")).length, 2, target);
  }
});

test("a second redirect is rejected without following it", async () => {
  const f = fixture({ secondStatus: 302 });
  await assert.rejects(f.reader(), /PUBLIC_PAGE_REDIRECT_REJECTED/);
  assert.equal(f.calls.filter(x => x.startsWith("GET")).length, 4);
});

test("redirect destination robots denial blocks document fetch", async () => {
  const f = fixture({
    policy: { status: 200, contentType: "text/plain", contentEncoding: "",
      body: "User-agent: SnapyCallResearchPreview\nDisallow: /ada/" },
  });
  await assert.rejects(f.reader(), /PUBLIC_PAGE_ROBOTS_REJECTED/);
  assert.equal(f.calls.filter(x => x.startsWith("GET")).length, 3);
});

test("unsafe redirect destination DNS blocks second page even with benign first DNS", async () => {
  let lookups = 0;
  const f = fixture({ resolver: async () => {
    lookups++;
    return [{ address: lookups >= 3 ? "127.0.0.1" : "8.8.8.8", family: 4 }];
  } });
  await assert.rejects(f.reader(), /PUBLIC_PAGE_DNS_REJECTED/);
  assert.equal(f.calls.filter(x => x.startsWith("GET")).length, 2);
});

test("redirect must not upgrade ambiguous or mismatched named email", async () => {
  const f = fixture();
  const page = await f.reader();
  assert.equal(classifyExplicitPersonEmailPage({
    name: "Grace Hopper", expertProfileUrl: cited, email: null,
  }, page).status, "UNVERIFIED");
});
