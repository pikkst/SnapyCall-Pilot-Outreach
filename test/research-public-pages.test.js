import test from "node:test";
import assert from "node:assert/strict";
import {
  isPublicIpv4, resolvePublicAddress, robotsAllows,
  retrieveCitedPublicPage,
} from "../server/research-public-pages.js";
import { classifyExplicitPersonEmailPage } from "../server/candidate-direct-email-evidence.js";

const source = "https://consultants.example.org/experts/abc";

test("DNS pinning rejects private, metadata, loopback and mixed answers", async () => {
  for (const blocked of ["127.0.0.1", "10.0.0.1", "169.254.169.254",
    "172.31.255.255", "192.168.1.2", "100.100.100.200",
    "192.0.0.7", "192.0.0.10", "192.0.0.255",
    "192.88.99.9", "192.0.2.1", "198.18.1.1",
    "203.0.113.4", "224.0.0.1"]) {
    assert.equal(isPublicIpv4(blocked), false, blocked);
    await assert.rejects(() => resolvePublicAddress("example.org", async () =>
      [{ address: "8.8.8.8", family: 4 }, { address: blocked, family: 4 }]),
    /DNS_REJECTED/);
  }
  assert.equal(isPublicIpv4("8.8.8.8"), true);
  assert.equal(isPublicIpv4("1.1.1.1"), true);
  assert.equal(isPublicIpv4("192.0.0.9"), false);
  assert.equal(await resolvePublicAddress("example.org", async () => [
    { address: "2606:4700:4700::1111", family: 6 },
    { address: "8.8.8.8", family: 4 },
  ]), "8.8.8.8");
  await assert.rejects(() => resolvePublicAddress("example.org", async () =>
    [{ address: "2606:4700:4700::1111", family: 6 }]), /NO_VALID_IPV4/);
});

test("robots exclusions and unsupported wildcard syntax fail closed", () => {
  const rules = "User-agent: *\nDisallow: /private\nAllow: /private/public\n";
  assert.equal(robotsAllows(rules, "/public"), true);
  assert.equal(robotsAllows(rules, "/private/info"), false);
  assert.equal(robotsAllows(rules, "/private/public/contact"), true);
  assert.equal(robotsAllows("User-agent: SnapyCallResearchPreview\nDisallow: /", "/"), false);
  assert.equal(robotsAllows("User-agent: *\nDisallow: /*/secret", "/a/secret"), false);
});

test("inspector validates HTTPS source, robots, pinned IP and safe HTML text", async () => {
  const requests = [];
  const retrieve = await retrieveCitedPublicPage(source, {
    resolve: async () => [{ address: "8.8.8.8", family: 4 }],
    request: async (url, address) => {
      requests.push({ url: String(url), address });
      if (String(url).endsWith("/robots.txt")) return {
        status: 200, contentType: "text/plain", contentEncoding: "",
        body: "User-agent: *\nDisallow: /private",
      };
      return {
        status: 200, contentType: "text/html; charset=utf-8",
        contentEncoding: "", body:
          "<html><script>info@evil.example.org</script><p>Contact &amp; info@consultants.example.org</p></html>",
      };
    },
  });
  assert.deepEqual(retrieve, {
    url: source, text: "Contact & info@consultants.example.org",
  });
  assert.deepEqual(requests.map(x => x.address), ["8.8.8.8", "8.8.8.8"]);
  assert.ok(requests[0].url.endsWith("/robots.txt"));
  assert.equal(requests[1].url, source);
});

test("inspector retains only explicitly labeled public mailto links", async () => {
  const retrieve = async html => retrieveCitedPublicPage(source, {
    resolve: async () => [{ address: "8.8.8.8", family: 4 }],
    request: async url => String(url).endsWith("/robots.txt")
      ? { status: 404, contentType: "text/plain", contentEncoding: "", body: "" }
      : { status: 200, contentType: "text/html", contentEncoding: "", body: html },
  });
  const evidence = await retrieve(
    '<p>Name: Ada Lovelace</p><a href="mailto:ada@example.org">Email</a>');
  assert.equal(evidence.text, "Name: Ada Lovelace Email: ada@example.org");
  const hidden = await retrieve(
    '<script><a href="mailto:secret@example.org">Email</a></script>' +
    '<a href="mailto:info@example.org">Contact us</a>');
  assert.equal(hidden.text, "Contact us");
  const query = await retrieve(
    '<a href="mailto:ada@example.org?subject=hello">Email</a>');
  assert.equal(query.text, "Email");
  const fake = await retrieve(
    '<a data-href="mailto:ada@example.org">Email</a>');
  assert.equal(fake.text, "Email");
});

test("one exact public H1 and mailto yield review-only evidence, not shared/ambiguous email", async () => {
  const inspect = async html => retrieveCitedPublicPage(source, {
    resolve: async () => [{ address: "8.8.8.8", family: 4 }],
    request: async url => String(url).endsWith("/robots.txt")
      ? { status: 404, contentType: "text/plain", contentEncoding: "", body: "" }
      : { status: 200, contentType: "text/html", contentEncoding: "", body: html },
  });
  const candidate = { name: "Ada Lovelace", expertProfileUrl: source, email: null };
  const good = await inspect('<h1>Ada Lovelace</h1><a href="mailto:ada@example.org">Email</a>');
  assert.equal(good.text, "Name: Ada Lovelace Email: ada@example.org");
  const evidence = classifyExplicitPersonEmailPage(candidate, good);
  assert.equal(evidence.status, "REVIEW_REQUIRED");
  assert.equal(evidence.emailNormalized, "ada@example.org");
  assert.equal(evidence.usableAsContact, false);
  for (const html of [
    '<h1>Our Team</h1><a href="mailto:ada@example.org">Email</a>',
    '<h1>Ada Lovelace</h1><h1>Grace Hopper</h1><a href="mailto:ada@example.org">Email</a>',
    '<h1>Ada Lovelace</h1><a href="mailto:ada@example.org">Email</a><p>office@example.org</p>',
  ]) {
    const page = await inspect(html);
    assert.equal(classifyExplicitPersonEmailPage(candidate, page).status, "UNVERIFIED");
  }
});

test("public 96 KiB HTML is inspectable within the bounded read limit", async () => {
  const html = "<h1>Ada Lovelace</h1>" + " ".repeat(96 * 1024) +
    '<a href="mailto:ada@example.org">Email</a>';
  const page = await retrieveCitedPublicPage(source, {
    resolve: async () => [{ address: "8.8.8.8", family: 4 }],
    request: async url => String(url).endsWith("/robots.txt")
      ? { status: 404, contentType: "text/plain", contentEncoding: "", body: "" }
      : { status: 200, contentType: "text/html; charset=utf-8",
        contentEncoding: "", body: html },
  });
  assert.equal(page.text, "Name: Ada Lovelace Email: ada@example.org");
});

test("inspector blocks disallowed robots, invalid MIME, redirect and oversized body", async () => {
  const base = {
    resolve: async () => [{ address: "8.8.8.8", family: 4 }],
  };
  await assert.rejects(() => retrieveCitedPublicPage(source, {
    ...base, request: async () => ({
      status: 200, contentType: "text/plain", contentEncoding: "",
      body: "User-agent: *\nDisallow: /experts",
    }),
  }), /ROBOTS_REJECTED/);
  for (const bad of [
    { status: 302, contentType: "text/html", contentEncoding: "", body: "" },
    { status: 200, contentType: "application/pdf", contentEncoding: "", body: "" },
    { status: 200, contentType: "text/html", contentEncoding: "gzip", body: "" },
    { status: 200, contentType: "text/html", contentEncoding: "", body: "x".repeat(131073) },
  ]) await assert.rejects(() => retrieveCitedPublicPage(source, {
    ...base, request: async url => String(url).endsWith("/robots.txt")
      ? { status: 404, contentType: "text/plain", contentEncoding: "", body: "" }
      : bad,
  }));
  await assert.rejects(() => retrieveCitedPublicPage("https://127.0.0.1/x"),
    /URL_REJECTED/);
});
