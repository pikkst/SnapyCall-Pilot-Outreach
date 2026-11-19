import test from "node:test";
import assert from "node:assert/strict";
import { selectEvidenceBackedPersonSource }
  from "../server/research-person-source-executor.js";

const subject = { name: "Ada Lovelace", category: "AI_AUTOMATION" };
const urls = [
  "https://example.org/ada",
  "https://example.net/ada",
  "https://example.com/ada",
  "https://example.edu/ada",
];
const candidate = (url, name = subject.name) => ({
  name, category: subject.category, sourceUrl: url,
  rationale: "Public professional biography for named specialist",
});
const preview = (list, sources = list.map(item => item.sourceUrl)) => ({
  candidates: list,
  sources: sources.map(url => ({ url, title: "Official professional bio" })),
});
const page = (url, email = "ada@example.org") => ({
  url, text: "Name: Ada Lovelace Email: " + email,
});

test("tries next independently cited profile after an unreadable source", async () => {
  const visited = [];
  const found = await selectEvidenceBackedPersonSource(
    preview([candidate(urls[0]), candidate(urls[1])]), subject, {
      retrieve: async url => {
        visited.push(url);
        if (url === urls[0]) throw new Error("PUBLIC_PAGE_ROBOTS_REJECTED");
        return page(url);
      },
    });
  assert.equal(found, urls[1]);
  assert.deepEqual(visited, [urls[0], urls[1]]);
});

test("does not turn unrelated, uncited or shared directory hits into evidence", async () => {
  const visited = [];
  const found = await selectEvidenceBackedPersonSource(preview([
    candidate(urls[0], "Grace Hopper"),
    candidate(urls[1]),
  ], [urls[0]]), subject, {
    retrieve: async url => { visited.push(url); return page(url); },
  });
  assert.equal(found, null);
  assert.deepEqual(visited, []);
});

test("rejects name-only pages and ambiguous mailboxes", async () => {
  const found = await selectEvidenceBackedPersonSource(
    preview([candidate(urls[0]), candidate(urls[1])]), subject, {
      retrieve: async url => ({
        url, text: url === urls[0]
          ? "Ada Lovelace - Contact: ada@example.org"
          : "Name: Ada Lovelace Email: info@example.net",
      }),
    });
  assert.equal(found, null);
});

test("conflicting verified addresses require review rather than picking one", async () => {
  const found = await selectEvidenceBackedPersonSource(
    preview([candidate(urls[0]), candidate(urls[1])]), subject, {
      retrieve: async url => page(url, url === urls[0]
        ? "ada@example.org" : "ada@example.net"),
    });
  assert.equal(found, null);
});

test("same verified mailbox across multiple public profiles remains one hint", async () => {
  const found = await selectEvidenceBackedPersonSource(
    preview([candidate(urls[0]), candidate(urls[0]), candidate(urls[1])]),
    subject, { retrieve: async url => page(url) });
  assert.equal(found, urls[0]);
});

test("inspects no more than three candidate URLs and never searches again", async () => {
  const visited = [];
  const found = await selectEvidenceBackedPersonSource(
    preview(urls.map(url => candidate(url))), subject, {
      retrieve: async url => {
        visited.push(url);
        return { url, text: "No published person-specific email" };
      },
    });
  assert.equal(found, null);
  assert.deepEqual(visited, urls.slice(0, 3));
});

test("source content cannot substitute a different URL as person evidence", async () => {
  const found = await selectEvidenceBackedPersonSource(
    preview([candidate(urls[0])]), subject, {
      retrieve: async () => page(urls[1]),
    });
  assert.equal(found, null);
});
