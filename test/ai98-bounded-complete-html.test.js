import test from "node:test";
import assert from "node:assert/strict";
import { retrieveCitedPublicPage, MAX_PUBLIC_HTML_BYTES }
  from "../server/research-public-pages.js";
import { classifyExplicitPersonEmailPage }
  from "../server/candidate-direct-email-evidence.js";

const source = "https://experts.example.org/people/ada";
const resolve = async () => [{ address: "8.8.8.8", family: 4 }];
const sourcePage = body => ({
  status: 200, contentType: "text/html; charset=utf-8",
  contentEncoding: "", body,
});
function fixture(html, options = {}) {
  const calls = [];
  const request = async (url, _address, limits) => {
    calls.push({ url: String(url), limit: limits?.maxBytes });
    return String(url).endsWith("/robots.txt")
      ? { status: 404, contentType: "text/plain",
          contentEncoding: "", body: "" }
      : sourcePage(html);
  };
  return {
    calls, retrieve: () => retrieveCitedPublicPage(source, {
      resolve, request, ...options,
    }),
  };
}
const candidate = { name: "Ada Lovelace", expertProfileUrl: source, email: null };

test("complete 256 KiB HTML retains explicit named mailto after long inert script", async () => {
  const html = "<h1>Ada Lovelace</h1><script>" +
    "x".repeat(256 * 1024) + "</script>" +
    '<a href="mailto:ada@example.org">Email</a>';
  const f = fixture(html);
  const page = await f.retrieve();
  assert.equal(page.text, "Name: Ada Lovelace Email: ada@example.org");
  const proof = classifyExplicitPersonEmailPage(candidate, page);
  assert.equal(proof.status, "REVIEW_REQUIRED");
  assert.equal(proof.emailNormalized, "ada@example.org");
  assert.deepEqual(f.calls.map(x => x.limit), [128 * 1024, 512 * 1024]);
  assert.equal(proof.usableAsContact, false);
});

test("complete 320 KiB HTML permits independently classified JSON-LD Person", async () => {
  const schema = '<script type="application/ld+json">' +
    JSON.stringify({ "@context": "https://schema.org", "@type": "Person",
      name: "Ada Lovelace", email: "ada@example.org" }) +
    "</script>";
  const page = await fixture("<h2>Expert</h2>" + "<!--" +
    "x".repeat(320 * 1024) + "-->" + schema).retrieve();
  assert.deepEqual(page.structuredPerson,
    { name: "Ada Lovelace", email: "ada@example.org" });
  assert.equal(classifyExplicitPersonEmailPage(candidate, page).status,
    "REVIEW_REQUIRED");
});

test("large completed HTML with excessive visible text fails closed", async () => {
  const html = "<h1>Ada Lovelace</h1>" + "X".repeat(170 * 1024) +
    '<a href="mailto:ada@example.org">Email</a>';
  await assert.rejects(fixture(html).retrieve(), /PUBLIC_PAGE_TOO_LARGE/);
});

test("oversized HTML is rejected, never treated as an acceptable prefix", async () => {
  const prefix = '<h1>Ada Lovelace</h1><a href="mailto:ada@example.org">Email</a>';
  await assert.rejects(fixture(prefix + "x".repeat(MAX_PUBLIC_HTML_BYTES))
    .retrieve(), /PUBLIC_PAGE_TOO_LARGE/);
});

test("reader passes distinct byte ceilings on each redirect's robots and document", async () => {
  const calls = [];
  const page = await retrieveCitedPublicPage(source, {
    resolve,
    request: async (url, _ip, { maxBytes } = {}) => {
      calls.push({ url: String(url), maxBytes });
      if (String(url).endsWith("/robots.txt")) return {
        status: 404, contentType: "text/plain", contentEncoding: "", body: "",
      };
      if (String(url) === source) return { status: 301,
        location: "https://www.experts.example.org/people/ada" };
      return sourcePage("<h1>Ada Lovelace</h1>");
    },
  });
  assert.equal(page.url, source);
  assert.deepEqual(calls.map(x => x.maxBytes),
    [128 * 1024, 512 * 1024, 128 * 1024, 512 * 1024]);
});

test("compressed pages stay disallowed regardless of 512 KiB capacity", async () => {
  await assert.rejects(retrieveCitedPublicPage(source, {
    resolve, request: async url => String(url).endsWith("/robots.txt")
      ? { status: 404, contentType: "text/plain", contentEncoding: "", body: "" }
      : { ...sourcePage("<h1>Ada Lovelace</h1>"), contentEncoding: "gzip" },
  }), /PUBLIC_PAGE_CONTENT_REJECTED/);
});
