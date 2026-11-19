import test from "node:test";
import assert from "node:assert/strict";
import { explicitJsonLdPersonEmail, explicitJsonLdMultiPersonContacts }
  from "../server/research-structured-person-evidence.js";
import { retrieveCitedPublicPage }
  from "../server/research-public-pages.js";
import { classifyExplicitPersonEmailPage }
  from "../server/candidate-direct-email-evidence.js";

const url = "https://experts.example.org/profiles/ada";
const target = { name: "Ada Lovelace", expertProfileUrl: url, email: null };
const script = data => '<script type="application/ld+json">' +
  JSON.stringify(data) + "</script>";
const person = (name = "Ada Lovelace", email = "ada@example.org") =>
  ({ "@context": "https://schema.org", "@type": "Person", name, email });

test("a single explicitly published schema Person yields review-only evidence", async () => {
  const html = '<h2>Professional profile</h2>' +
    script(person("Ada Lovelace", "mailto:ada@example.org"));
  const page = await retrieveCitedPublicPage(url, {
    resolve: async () => [{ address: "8.8.8.8", family: 4 }],
    request: async uri => String(uri).endsWith("/robots.txt")
      ? { status: 404, contentType: "text/plain", contentEncoding: "", body: "" }
      : { status: 200, contentType: "text/html", contentEncoding: "", body: html },
  });
  assert.equal(page.text, "Professional profile");
  assert.deepEqual(page.structuredPerson,
    { name: "Ada Lovelace", email: "ada@example.org" });
  const proof = classifyExplicitPersonEmailPage(target, page);
  assert.equal(proof.status, "REVIEW_REQUIRED");
  assert.equal(proof.reason, "EXPLICIT_JSONLD_PERSON_EMAIL");
  assert.equal(proof.emailNormalized, "ada@example.org");
  assert.match(proof.evidenceDigest, /^[a-f0-9]{64}$/);
  assert.equal(proof.usableAsContact, false);
  assert.equal(proof.onboardingEligible, false);
});

test("a bounded @graph with one Person is accepted, organization email ignored", () => {
  const result = explicitJsonLdPersonEmail(script({
    "@context": "https://schema.org", "@graph": [
      { "@type": "Organization", name: "Example", email: "info@example.org" },
      { "@type": "Person", name: "Ada Lovelace", email: "ada@example.org" },
    ],
  }));
  assert.deepEqual(result, { name: "Ada Lovelace", email: "ada@example.org" });
});

test("multiple people, missing context, malformed scripts and nested identity fail closed", () => {
  const cases = [
    script({ "@type": "Person", name: "Ada Lovelace", email: "ada@example.org" }),
    script({ "@context": "https://example.org", "@type": "Person",
      name: "Ada Lovelace", email: "ada@example.org" }),
    script({ "@context": "https://schema.org", "@graph": [
      { "@type": "Person", name: "Ada Lovelace", email: "ada@example.org" },
      { "@type": "Person", name: "Grace Hopper", email: "grace@example.org" },
    ] }),
    script(person()) + script(person()),
    script({ "@context": "https://schema.org", "@type": "Organization",
      member: person() }),
    script({ "@context": "https://schema.org", "@type": "Person",
      name: ["Ada Lovelace"], email: ["ada@example.org"] }),
    '<script type="application/ld+json">{malformed}</script>',
    script({ "@context": "https://schema.org", "@type": "Person",
      name: "Ada Lovelace", email: "https://example.org/contact" }),
  ];
  for (const html of cases)
    assert.equal(explicitJsonLdPersonEmail(html), null);
});

test("an oversized JSON-LD graph cannot hide a later second identity", () => {
  const graph = [
    { "@type": "Person", name: "Ada Lovelace", email: "ada@example.org" },
    ...Array.from({ length: 19 }, (_, i) => ({
      "@type": "Organization", name: "Example " + i,
    })),
    { "@type": "Person", name: "Grace Hopper", email: "grace@example.org" },
  ];
  assert.equal(explicitJsonLdPersonEmail(script({
    "@context": "https://schema.org", "@graph": graph,
  })), null);
  assert.equal(explicitJsonLdPersonEmail(script({
    "@context": "https://schema.org", "@graph": [
      ...graph.slice(0, 20),
      { "@type": "Organization", name: "Later" },
    ],
  })), null);
});

test("generic company email and a wrong person cannot pass classification", () => {
  for (const schema of [
    person("Ada Lovelace", "info@example.org"),
    person("Grace Hopper", "ada@example.org"),
  ]) {
    const proof = classifyExplicitPersonEmailPage(target, {
      url, text: "Professional profile",
      structuredPerson: explicitJsonLdPersonEmail(script(schema)),
    });
    assert.equal(proof.status, "UNVERIFIED");
  }
});

test("a conflicting visible mailbox or labeled identity blocks schema evidence", () => {
  for (const text of [
    "Contact: grace@example.org",
    "Email: info@example.org",
    "Name: Grace Hopper Email: ada@example.org",
  ]) {
    const proof = classifyExplicitPersonEmailPage(target, {
      url, text, structuredPerson: person().email &&
        explicitJsonLdPersonEmail(script(person())),
    });
    assert.equal(proof.status, "UNVERIFIED", text);
    assert.equal(proof.reason, "STRUCTURED_PERSON_EVIDENCE_CONFLICT");
  }
});

test("unchanged strict text classifier rejects unsupported metadata and guessing", () => {
  for (const html of [
    '<script type="application/json">' + JSON.stringify(person()) + "</script>",
    '<script type="application/ld+json">' + JSON.stringify({
      "@context": "https://schema.org", "@type": "Organization",
      name: "Ada Lovelace", email: "ada@example.org",
    }) + "</script>",
  ]) {
    const proof = classifyExplicitPersonEmailPage(target, {
      url, text: "Professional profile",
      structuredPerson: explicitJsonLdPersonEmail(html),
    });
    assert.equal(proof.status, "UNVERIFIED");
  }
});

test("bounded multi-Person graph yields individually scoped review evidence", async () => {
  const html = "<h2>Our team</h2>" + script({
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "Organization", name: "Example", email: "info@example.org" },
      { "@type": "Person", name: "Ada Lovelace", email: "ada@example.org" },
      { "@type": "Person", name: "Grace Hopper", email: "grace@example.org" },
    ],
  });
  const page = await retrieveCitedPublicPage(url, {
    resolve: async () => [{ address: "8.8.8.8", family: 4 }],
    request: async input => String(input).endsWith("/robots.txt")
      ? { status: 404, contentType: "text/plain", contentEncoding: "", body: "" }
      : { status: 200, contentType: "text/html", contentEncoding: "", body: html },
  });
  assert.equal(page.structuredPerson, undefined);
  assert.deepEqual(page.structuredContacts, [
    { name: "Ada Lovelace", email: "ada@example.org" },
    { name: "Grace Hopper", email: "grace@example.org" },
  ]);
  const proof = classifyExplicitPersonEmailPage(target, page);
  assert.equal(proof.status, "REVIEW_REQUIRED");
  assert.equal(proof.reason, "EXPLICIT_SCOPED_JSONLD_PERSON_EMAIL");
  assert.equal(proof.sourceScoped, true);
  assert.equal(proof.emailNormalized, "ada@example.org");
  assert.equal(proof.usableAsContact, false);
  assert.equal(proof.onboardingEligible, false);
  const other = classifyExplicitPersonEmailPage({
    ...target, name: "Grace Hopper",
  }, page);
  assert.equal(other.status, "REVIEW_REQUIRED");
  assert.equal(other.emailNormalized, "grace@example.org");
  assert.notEqual(other.evidenceDigest, proof.evidenceDigest);
});

test("multi-Person schema never promotes ambiguous, generic or duplicate contacts", () => {
  const bad = [
    [person("Ada Lovelace", "ada@example.org"),
      person("Grace Hopper", "ada@example.org")],
    [person("Ada Lovelace", "ada@example.org"),
      person("Ada Lovelace", "other@example.org")],
    [person("Ada Lovelace", "ada@example.org"),
      person("Grace Hopper", "info@example.org")],
    [person("Ada Lovelace", "ada@example.org"),
      { "@context": "https://schema.org", "@type": "Person", name: "Grace Hopper" }],
  ];
  for (const records of bad) {
    const html = records.map(script).join("");
    const contacts = explicitJsonLdMultiPersonContacts(html);
    const proof = classifyExplicitPersonEmailPage(target, {
      url, text: "Team biography", structuredContacts: contacts,
    });
    assert.equal(proof.status, "UNVERIFIED");
  }
});

test("another named person's email cannot be attributed to the requested person", () => {
  const contacts = explicitJsonLdMultiPersonContacts(
    script(person("Grace Hopper", "grace@example.org")) +
    script(person("John Smith", "john@example.org")));
  const proof = classifyExplicitPersonEmailPage(target, {
    url, text: "Team biography", structuredContacts: contacts,
  });
  assert.equal(proof.status, "UNVERIFIED");
  assert.equal(proof.reason, "SHARED_PERSON_IDENTITY_MISSING");
});

test("explicit visible contradiction overrides multi-Person structured data", () => {
  const contacts = explicitJsonLdMultiPersonContacts(
    script(person("Ada Lovelace", "ada@example.org")) +
    script(person("Grace Hopper", "grace@example.org")));
  const proof = classifyExplicitPersonEmailPage(target, {
    url, text: "Name: Ada Lovelace Email: other@example.org",
    structuredContacts: contacts,
  });
  assert.equal(proof.status, "UNVERIFIED");
  assert.equal(proof.reason, "SHARED_PERSON_BLOCKS_AMBIGUOUS");
});
