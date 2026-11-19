import test from "node:test";
import assert from "node:assert/strict";
import { robotsAllows, retrieveCitedPublicPage,
  supportedPublicTextMediaType } from "../server/research-public-pages.js";

test("unrelated wildcard rules do not veto access", () => {
  const robots = "User-agent: OtherBot\nDisallow: /*\n" +
    "User-agent: SnapyCallResearchPreview\nAllow: /experts/\n";
  assert.equal(robotsAllows(robots, "/experts/ada"), true);
});

test("robots wildcard disallow and scoped exception follow longest match", () => {
  const robots = "User-agent: *\nDisallow: /experts/*\n" +
    "Allow: /experts/public/*\n";
  assert.equal(robotsAllows(robots, "/experts/private/ada"), false);
  assert.equal(robotsAllows(robots, "/experts/public/ada"), true);
  assert.equal(robotsAllows(robots, "/other/ada"), true);
});

test("end anchor matches entire path, not arbitrary suffix", () => {
  const robots = "User-agent: *\nDisallow: /*.pdf$\n";
  assert.equal(robotsAllows(robots, "/experts/ada.pdf"), false);
  assert.equal(robotsAllows(robots, "/experts/ada.pdf.html"), true);
  assert.equal(robotsAllows(robots, "/experts/ada.pdf?download=1"), true);
});

test("tie resolves toward Allow even when Disallow appears last", () => {
  const robots = "User-agent: *\nAllow: /public/*\nDisallow: /public/*\n";
  assert.equal(robotsAllows(robots, "/public/profile"), true);
});

test("specific crawler groups override generic rules", () => {
  const robots = "User-agent: *\nDisallow: /\n" +
    "User-agent: SnapyCallResearchPreview\nAllow: /experts\n";
  assert.equal(robotsAllows(robots, "/experts/ada"), true);
  assert.equal(robotsAllows(robots, "/private/ada"), true);
  const forbidden = "User-agent: *\nAllow: /\n" +
    "User-agent: SnapyCallResearchPreview\nDisallow: /\n";
  assert.equal(robotsAllows(forbidden, "/experts/ada"), false);
});

test("multiple specific groups are combined and longest rule wins", () => {
  const robots = "User-agent: SnapyCallResearchPreview\nDisallow: /team\n" +
    "User-agent: SnapyCallResearchPreview\nAllow: /team/public\n";
  assert.equal(robotsAllows(robots, "/team/public/ada"), true);
  assert.equal(robotsAllows(robots, "/team/private/ada"), false);
});

test("malformed selected rules fail closed and unselected malformed rules do not", () => {
  const other = "User-agent: SomeOtherBot\nDisallow: /bad$stuff\n" +
    "User-agent: SnapyCallResearchPreview\nAllow: /\n";
  assert.equal(robotsAllows(other, "/experts/ada"), true);
  assert.equal(robotsAllows("User-agent: *\nDisallow: /bad$stuff\n",
    "/experts/ada"), false);
  assert.equal(robotsAllows("User-agent: *\nDisallow: /private\n",
    "/private/data"), false);
  assert.equal(robotsAllows("User-agent: *\nDisallow:\n",
    "/experts/ada"), true);
});

test("HTTPS reader consults robots for page query too", async () => {
  const requests = [];
  const source = "https://experts.example.org/profiles/ada?view=private";
  await assert.rejects(retrieveCitedPublicPage(source, {
    resolve: async () => [{ address: "8.8.8.8", family: 4 }],
    request: async url => {
      requests.push(String(url));
      return { status: 200, contentType: "text/plain",
        contentEncoding: "",
        body: "User-agent: *\nDisallow: /*?view=private$\n" };
    },
  }), /PUBLIC_PAGE_ROBOTS_REJECTED/);
  assert.equal(requests.length, 1);
});

test("robots file remains restrictive when wildcard rule denies a URL", async () => {
  let pageRequested = false;
  await assert.rejects(retrieveCitedPublicPage(
    "https://experts.example.org/private/ada", {
      resolve: async () => [{ address: "8.8.8.8", family: 4 }],
      request: async url => {
        if (!String(url).endsWith("/robots.txt")) {
          pageRequested = true;
          throw new Error("Unauthorised fetch");
        }
        return { status: 200, contentType: "text/plain",
          contentEncoding: "", body: "User-agent: *\nDisallow: /private/*" };
      },
    }), /PUBLIC_PAGE_ROBOTS_REJECTED/);
  assert.equal(pageRequested, false);
});

test("RFC 9110 media type accepts quoted UTF-8 but no other encoding", () => {
  assert.equal(supportedPublicTextMediaType('text/html; charset="utf-8"'),
    "text/html");
  assert.equal(supportedPublicTextMediaType("Text/HTML; Charset=UTF-8"),
    "text/html");
  assert.equal(supportedPublicTextMediaType("text/plain ; charset=UTF-8"),
    "text/plain");
  for (const value of [
    "application/json", "application/octet-stream",
    'text/html; charset="iso-8859-1"',
    "text/html; charset=UTF-8; charset=UTF-8",
    "text/html; charset=",
  ]) {
    assert.equal(supportedPublicTextMediaType(value), null, value);
  }
});

test("retriever allows quoted UTF-8 HTML with canonical robots guards", async () => {
  const source = "https://experts.example.org/people/ada";
  const page = await retrieveCitedPublicPage(source, {
    resolve: async () => [{ address: "8.8.8.8", family: 4 }],
    request: async url => String(url).endsWith("/robots.txt")
      ? { status: 200, contentType: 'text/plain; charset="UTF-8"',
          contentEncoding: "",
          body: "User-agent: *\nDisallow: /private/*\n" }
      : { status: 200, contentType: 'text/html; charset="utf-8"',
          contentEncoding: "",
          body: '<h1>Ada Lovelace</h1><a href="/contact">Contact</a>' },
  });
  assert.equal(page.text, "Name: Ada Lovelace Contact");
  assert.equal(page.linkedContactUrl, "https://experts.example.org/contact");
});

test("robots policy still blocks actual wildcard deny", async () => {
  let fetched = false;
  await assert.rejects(retrieveCitedPublicPage(
    "https://experts.example.org/private/ada", {
      resolve: async () => [{ address: "8.8.8.8", family: 4 }],
      request: async url => {
        if (!String(url).endsWith("/robots.txt")) {
          fetched = true;
          throw new Error("Blocked page was requested");
        }
        return { status: 200, contentType: 'text/plain; charset="utf-8"',
          contentEncoding: "", body: "User-agent: *\nDisallow: /private/*" };
      },
    }), /PUBLIC_PAGE_ROBOTS_REJECTED/);
  assert.equal(fetched, false);
});
