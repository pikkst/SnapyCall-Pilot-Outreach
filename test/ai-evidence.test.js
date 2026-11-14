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

test("Claude uses the fixed Anthropic Messages endpoint with personal BYOK key", async () => {
  const candidate = {
    name: "Example Consultant", category: "COACHING",
    sourceUrl: "https://example.org/profile", onlineEnglish: true,
  };
  let called = 0;
  const result = await generateDraft({
    provider: "anthropic", model: "claude-sonnet-4-6",
    apiKey: "personal-anthropic-test-key", candidate,
  }, {
    post: async (url, headers, payload, signal) => {
      called++;
      assert.equal(url, "https://api.anthropic.com/v1/messages");
      assert.deepEqual(headers, {
        "x-api-key": "personal-anthropic-test-key",
        "anthropic-version": "2023-06-01",
      });
      assert.equal(payload.model, "claude-sonnet-4-6");
      assert.equal(payload.max_tokens, 700);
      assert.equal(payload.messages.length, 1);
      assert.match(payload.messages[0].content, /Do not invent credentials/);
      assert.ok(signal instanceof AbortSignal);
      return { stop_reason: "end_turn", content: [
        { type: "text", text: "Expert invitation" },
        { type: "text", text: "\n\nA factual invitation." },
      ] };
    },
  });
  assert.equal(called, 1);
  assert.deepEqual(result, {
    subject: "Expert invitation", body: "A factual invitation.",
  });
});

test("Claude fails closed on truncated, tool-use, or malformed output", async () => {
  const args = {
    provider: "anthropic", model: "claude-sonnet-4-6",
    apiKey: "personal-anthropic-test-key",
    candidate: {
      name: "Example Consultant", category: "COACHING",
      sourceUrl: "https://example.org/profile", onlineEnglish: true,
    },
  };
  for (const result of [
    { stop_reason: "max_tokens", content: [{ type: "text", text: "Subject\n\nIncomplete" }] },
    { stop_reason: "tool_use", content: [{ type: "tool_use", name: "external" }] },
    { stop_reason: "end_turn", content: [{ type: "thinking", thinking: "hidden" }] },
    { stop_reason: "end_turn", content: [] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "No body" }] },
  ]) {
    await assert.rejects(() => generateDraft(args, { post: async () => result }));
  }
  await assert.rejects(() => generateDraft({ ...args, provider: "unknown" },
    { post: async () => ({}) }));
});
