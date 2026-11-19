import test from "node:test";
import assert from "node:assert/strict";
import { linkedPublicContactUrl } from "../server/research-public-pages.js";
import { inspectNamedPublicContactEvidence, LINKED_CONTACT_PROVENANCE }
  from "../server/research-linked-contact-proof.js";
import { inspectEvidenceBackedPersonSources }
  from "../server/research-person-source-executor.js";

const root = "https://profiles.example.org/experts/ada";
const linked = "https://profiles.example.org/contact";
const name = "Ada Lovelace";
const subject = { name, category: "AI_AUTOMATION" };
const profile = { url: root, text: "Name: Ada Lovelace - AI expert",
  linkedContactUrl: linked };
const evidence = { url: linked, text: "Name: Ada Lovelace Email: ada@example.org" };
const preview = { candidates: [{
  name, category: subject.category, sourceUrl: root,
  rationale: "Named professional biography at a public expert website",
}], sources: [{ url: root, title: "Professional profile" }] };

test("only one directly linked same-host contact document is admissible", () => {
  assert.equal(linkedPublicContactUrl(root,
    '<a href="/contact">Contact</a>'), linked);
  assert.equal(linkedPublicContactUrl(root,
    '<a href="/contact">Contact</a><a href="/get-in-touch">Get in touch</a>'), null);
  for (const href of [
    "https://evil.example.org/contact", "http://profiles.example.org/contact",
    "https://profiles.example.org:8080/contact", "/contact?redirect=http://evil.test",
    "/admin", "javascript:alert(1)", "//127.0.0.1/contact",
  ]) {
    assert.equal(linkedPublicContactUrl(root,
      '<a href="' + href + '">Contact</a>'), null);
  }
  assert.equal(linkedPublicContactUrl(root,
    '<script><a href="/contact">Contact</a></script>'), null);
  assert.equal(linkedPublicContactUrl(root,
    '<!-- <a href="/contact">Contact</a> -->'), null);
  assert.equal(linkedPublicContactUrl(root,
    '<template><a href="/contact">Contact</a></template>'), null);
  assert.equal(linkedPublicContactUrl(root,
    '<a href="/contact" hidden>Contact</a>'), null);
  assert.equal(linkedPublicContactUrl(root,
    '<a data-href="/contact">Contact</a>'), null);
  assert.equal(linkedPublicContactUrl(root,
    '<a href="/contact">Other text</a>'), null);
});

test("linked page must independently contain same named person and personal email", async () => {
  const visits = [];
  const found = await inspectNamedPublicContactEvidence({
    url: root, name, retrieve: async url => {
      visits.push(url);
      return url === root ? profile : evidence;
    },
  });
  assert.equal(found.linked, true);
  assert.equal(found.evidence.profileUrl, root);
  assert.equal(found.evidence.emailNormalized, "ada@example.org");
  assert.match(found.evidence.evidenceDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(visits, [root, linked]);
  assert.equal(LINKED_CONTACT_PROVENANCE,
    "AI98_EXPLICIT_NAMED_EMAIL_ON_LINKED_CONTACT");
});

test("name-only profile and generic contact address never qualify", async () => {
  const found = await inspectNamedPublicContactEvidence({
    url: root, name, retrieve: async url => url === root ? profile : {
      url: linked, text: "Name: Ada Lovelace Email: info@example.org",
    },
  });
  assert.equal(found.evidence, null);
  assert.equal(found.linkedAttempted, true);
});

test("namesake, unlabeled email and multi-email page are not person proof", async () => {
  for (const text of [
    "Name: Grace Hopper Email: ada@example.org",
    "Ada Lovelace ada@example.org",
    "Name: Ada Lovelace Email: ada@example.org contact@example.org",
    "Name: Ada Lovelace Email: another@example.org Email: ada@example.org",
  ]) {
    const found = await inspectNamedPublicContactEvidence({
      url: root, name, retrieve: async url =>
        url === root ? profile : { url: linked, text },
    });
    assert.equal(found.evidence, null);
  }
});

test("unavailable linked page cannot bypass access controls", async () => {
  const found = await inspectNamedPublicContactEvidence({
    url: root, name, retrieve: async url => {
      if (url === root) return profile;
      throw new Error("PUBLIC_PAGE_ROBOTS_REJECTED");
    },
  });
  assert.equal(found.evidence, null);
  assert.equal(found.linkedUnavailable, true);
});

test("provider-cited root remains the selected URL and one contact follow is bounded", async () => {
  const visits = [];
  const found = await inspectEvidenceBackedPersonSources(preview, subject, {
    retrieve: async url => {
      visits.push(url);
      return url === root ? profile : evidence;
    },
  });
  assert.equal(found.proposedUrl, root);
  assert.deepEqual(visits, [root, linked]);
  assert.equal(found.diagnostics.reason, "SOURCE_NAMED_EMAIL_SOURCE_SELECTED");
});

test("lease guard disables linked follow without blocking direct proof", async () => {
  const visits = [];
  const found = await inspectEvidenceBackedPersonSources(preview, subject, {
    mayFollowLinked: () => false,
    retrieve: async url => { visits.push(url); return profile; },
  });
  assert.equal(found.proposedUrl, null);
  assert.deepEqual(visits, [root]);
});

test("no second contact follow across multiple cited roots", async () => {
  const second = "https://others.example.org/experts/ada";
  const secondContact = "https://others.example.org/contact";
  const p = {
    candidates: [preview.candidates[0], {
      ...preview.candidates[0], sourceUrl: second,
    }], sources: [{ url: root }, { url: second }],
  };
  const visits = [];
  const found = await inspectEvidenceBackedPersonSources(p, subject, {
    retrieve: async url => {
      visits.push(url);
      if (url === root || url === second)
        return { url, text: "Name: Ada Lovelace",
          linkedContactUrl: url === root ? linked : secondContact };
      return { url, text: "No named email found" };
    },
  });
  assert.equal(found.proposedUrl, null);
  assert.deepEqual(visits, [root, linked, second]);
});

test("direct named-email proof does not trigger an extra contact fetch", async () => {
  const visits = [];
  const found = await inspectNamedPublicContactEvidence({
    url: root, name, retrieve: async url => {
      visits.push(url);
      return { url, text: "Name: Ada Lovelace Email: ada@example.org",
        linkedContactUrl: linked };
    },
  });
  assert.ok(found.evidence);
  assert.equal(found.linkedAttempted, false);
  assert.deepEqual(visits, [root]);
});
