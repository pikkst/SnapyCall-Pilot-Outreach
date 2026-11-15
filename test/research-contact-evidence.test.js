import test from "node:test";
import assert from "node:assert/strict";
import { observedPublicBusinessContacts } from "../server/research-contact-evidence.js";

const url = "https://consulting.example.org/contact";

test("server-observed public business mailboxes retain exact provenance and require review", () => {
  const found = observedPublicBusinessContacts({
    citationUrls: [url],
    trustedPages: [{ url, text: "For business inquiries write info@consulting.example.org or info@consulting.example.org." }],
  });
  assert.deepEqual(found, [{
    type: "PUBLIC_BUSINESS_INBOX", observedEmail: "info@consulting.example.org",
    sourceUrl: url, provenance: "SERVER_INSPECTED_PAGE", status: "REVIEW_REQUIRED",
    identityVerified: false, contactPermission: false,
  }]);
});

test("model-suggested or uncited page contacts cannot become evidence", () => {
  const pages = [{ url, text: "Email: hello@consulting.example.org" }];
  assert.deepEqual(observedPublicBusinessContacts({
    citationUrls: ["https://unrelated.example.org"], trustedPages: pages,
  }), []);
  assert.deepEqual(observedPublicBusinessContacts({
    citationUrls: [url], trustedPages: [], 
  }), []);
});

test("personal mail, unrelated domains and unsafe URLs are rejected", () => {
  const result = observedPublicBusinessContacts({
    citationUrls: [url, "https://private.example.org", "http://unsafe.example.org"],
    trustedPages: [
      { url, text: "john@consulting.example.org, info@gmail.com, admin@other.example.org, hello@consulting.example.org" },
      { url: "http://unsafe.example.org", text: "hello@unsafe.example.org" },
      { url: "https://localhost/private", text: "hello@localhost" },
    ],
  });
  assert.deepEqual(result.map(x => x.observedEmail), ["hello@consulting.example.org"]);
});

test("reject unbounded inspections and preserve deterministic order", () => {
  assert.throws(() => observedPublicBusinessContacts({
    citationUrls: [url], trustedPages: Array(21).fill({ url, text: "" }),
  }), TypeError);
  assert.throws(() => observedPublicBusinessContacts({
    citationUrls: Array(201).fill(url), trustedPages: [],
  }), TypeError);
  assert.deepEqual(observedPublicBusinessContacts({
    citationUrls: [url],
    trustedPages: [{ url, text: "contact@consulting.example.org; support@consulting.example.org" }],
  }).map(x => x.observedEmail), [
    "contact@consulting.example.org", "support@consulting.example.org",
  ]);
});
