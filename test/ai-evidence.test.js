import test from "node:test";
import assert from "node:assert/strict";
import { generateDraft } from "../server/ai.js";

test("AI draft prompt keeps RSS article provenance and reviewed profile distinct", async () => {
  let prompt = "";
  const candidate = {
    name: "Example Author", category: "AI_AUTOMATION",
    discoveryKey: "x".repeat(64),
    sourceUrl: "https://example.org/article",
    expertProfileUrl: "https://consultants.example.org/profile",
    profileReviewed: true, onlineEnglish: true,
  };
  const generated = await generateDraft({
    provider: "gemini", model: "gemini-2.5-flash", apiKey: "test-only-key-value", candidate,
  }, {
    post: async (_url, _headers, payload) => {
      prompt = payload.contents[0].parts[0].text;
      return { candidates: [{ content: { parts: [{ text: "Pilot invitation\n\nA short invitation." }] } }] };
    },
  });
  assert.equal(generated.subject, "Pilot invitation");
  assert.match(prompt, /Source article\/provenance URL: https:\/\/example\.org\/article/);
  assert.match(prompt, /Separately reviewed expert profile URL: https:\/\/consultants\.example\.org\/profile/);
  assert.match(prompt, /contents were NOT fetched/);
  assert.match(prompt, /Do not claim expertise/);
});

test("legacy manual candidate source remains accessible as profile reference", async () => {
  let prompt = "";
  await generateDraft({
    provider: "gemini", model: "gemini-2.5-flash", apiKey: "test-only-key-value",
    candidate: { name: "Manual Expert", category: "COACHING",
      sourceUrl: "https://example.org/coach", onlineEnglish: true },
  }, {
    post: async (_url, _headers, payload) => {
      prompt = payload.contents[0].parts[0].text;
      return { candidates: [{ content: { parts: [{ text: "Subject\n\nBody." }] } }] };
    },
  });
  assert.match(prompt, /Separately reviewed expert profile URL: https:\/\/example\.org\/coach/);
});
