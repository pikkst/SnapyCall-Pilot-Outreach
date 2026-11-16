import test from "node:test";
import assert from "node:assert/strict";
import { researchCandidates, researchInput, ResearchProviderHttpError, publicResearchProviderFailure } from "../server/ai-research.js";

const args = {
  query: "Find English-speaking professional AI automation consultants in the UK",
  limit: 10, model: "claude-sonnet-4-6", apiKey: "personal-test-api-key",
};
const cited = url => ({
  stop_reason: "end_turn",
  usage: { input_tokens: 350, output_tokens: 220, server_tool_use: { web_search_requests: 1 } },
  content: [
    { type: "server_tool_use", name: "web_search" },
    { type: "web_search_tool_result", content: [{ type: "web_search_result", url }] },
    { type: "text", text: JSON.stringify({ candidates: [
      { name: "Verified Example", category: "AI_AUTOMATION", sourceUrl: url,
        rationale: "Public consultant profile linked in the provider search result" },
      { name: "Invented Source", category: "COACHING",
        sourceUrl: "https://uncited.example.org", rationale: "Not actually cited by provider" },
    ] }), citations: [{ type: "web_search_result_location", url, title: "Consultant profile" }] },
  ],
});

test("Claude research uses fixed endpoint, bounded search and own key", async () => {
  const result = await researchCandidates(args, { post: async (url, headers, payload) => {
    assert.equal(url, "https://api.anthropic.com/v1/messages");
    assert.equal(headers["x-api-key"], args.apiKey);
    assert.equal(payload.tools[0].max_uses, 3);
    assert.match(payload.messages[0].content, /public internet broadly/);
    assert.equal(payload.model, args.model);
    return cited("https://profile.example.org/consultant");
  } });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].email, null);
  assert.equal(result.candidates[0].contactReviewed, false);
  assert.equal(result.candidates[0].profileReviewed, false);
  assert.equal(result.imported, false);
  assert.equal(result.sendingEnabled, false);
  assert.equal(result.usage.searchRequests, 1);
  assert.equal(result.sources.length, 1);
});

test("uncited and unsafe source URLs cannot be promoted to candidate", async () => {
  for (const url of ["http://profile.example.org/consultant",
    "https://localhost/private", "https://127.0.0.1/private",
    "https://test.internal/profile"]) {
    const result = await researchCandidates(args, { post: async () => cited(url) });
    assert.equal(result.candidates.length, 0);
  }
});

test("search failures, partial output, and no tool usage fail closed", async () => {
  for (const response of [
    { ...cited("https://profile.example.org"), stop_reason: "max_tokens" },
    { ...cited("https://profile.example.org"), content: cited("https://profile.example.org").content.slice(1) },
    { ...cited("https://profile.example.org"), content: [
      { type: "server_tool_use", name: "web_search" },
      { type: "web_search_tool_result", content: { type: "web_search_tool_result_error", error_code: "unavailable" } },
    ] },
  ]) await assert.rejects(() => researchCandidates(args, { post: async () => response }));
});

test("research criteria and candidate limits are bounded", () => {
  assert.equal(researchInput.safeParse({ query: "short", limit: 10 }).success, false);
  assert.equal(researchInput.safeParse({ query: "A reasonable expert search", limit: 21 }).success, false);
  assert.equal(researchInput.safeParse({ query: "A reasonable expert search", limit: 1, workspaceId: "forged" }).success, false);
});

test("provider rejection is classified without leaking sensitive upstream text", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false, status: 403,
    json: async () => ({ error: { message: "sk-test-secret-do-not-log" } }),
  });
  try {
    await assert.rejects(
      () => researchCandidates(args),
      error => error instanceof ResearchProviderHttpError &&
        error.status === 403 &&
        !String(error.message).includes("sk-test-secret"),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider failures map to safe and actionable public error codes", () => {
  const cases = [
    [400, "RESEARCH_PROVIDER_INVALID_REQUEST"],
    [401, "RESEARCH_PROVIDER_ACCESS_DENIED"],
    [403, "RESEARCH_PROVIDER_ACCESS_DENIED"],
    [402, "RESEARCH_PROVIDER_CREDITS_REQUIRED"],
    [429, "RESEARCH_PROVIDER_RATE_LIMITED"],
    [500, "RESEARCH_PROVIDER_UNAVAILABLE"],
    [503, "RESEARCH_PROVIDER_UNAVAILABLE"],
  ];
  for (const [status, code] of cases) {
    const value = publicResearchProviderFailure(status);
    assert.equal(value.code, code);
    assert.equal(typeof value.error, "string");
    assert.ok(value.error.length > 15);
    assert.doesNotMatch(JSON.stringify(value), /secret|bearer|sk-test/i);
  }
});
