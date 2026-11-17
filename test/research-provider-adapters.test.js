import test from "node:test";
import assert from "node:assert/strict";
import { researchCandidates } from "../server/ai-research.js";

const source = "https://consultants.example.org/experts/verified";
const candidate = {
  name: "Verified Professional", category: "AI_AUTOMATION", sourceUrl: source,
  rationale: "Source-cited professional consulting profile for manual verification",
};
const query = "Find English speaking independent AI automation experts in Europe";
const raw = JSON.stringify({ candidates: [candidate, {
  ...candidate, name: "Unsupported Citation", sourceUrl: "https://invented.example.org",
}] });

test("OpenAI Responses search uses own BYOK, native search and trusted citation annotations", async () => {
  const result = await researchCandidates({ provider: "openai", model: "gpt-4.1-mini",
    apiKey: "openai-test-user-key", query }, { post: async (url, headers, payload) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.equal(headers.authorization, "Bearer openai-test-user-key");
    assert.deepEqual(payload.tools, [{ type: "web_search", search_context_size: "low" }]);
    assert.equal(payload.max_output_tokens, 3200);
    assert.equal(payload.max_tool_calls, 3);
    assert.match(payload.input, /public internet broadly/);
    assert.match(payload.input, /manual review/);
    return { status: "completed", usage: { input_tokens: 120, output_tokens: 90 },
      output: [
        { type: "web_search_call", status: "completed" },
        { type: "message", role: "assistant", content: [{
          type: "output_text", text: raw,
          annotations: [{ type: "url_citation", url: source, title: "Verified expert" }],
        }] },
      ] };
  } });
  assert.equal(result.provider, "openai");
  assert.deepEqual(result.candidates.map(c => c.name), ["Verified Professional"]);
  assert.equal(result.candidates[0].email, null);
  assert.equal(result.imported, false);
  assert.equal(result.sendingEnabled, false);
  assert.equal(result.usage.searchRequests, 1);
  assert.equal(result.usage.billingEvidence, undefined,
    "Provider adapter cannot certify complete billable units yet");
});

test("Gemini Search Grounding only accepts provider grounding chunks", async () => {
  const result = await researchCandidates({ provider: "gemini", model: "gemini-2.5-flash",
    apiKey: "gemini-test-user-key", query }, { post: async (url, headers, payload) => {
    assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    assert.equal(headers["x-goog-api-key"], "gemini-test-user-key");
    assert.deepEqual(payload.tools, [{ google_search: {} }]);
    assert.deepEqual(payload.generationConfig.thinkingConfig, { thinkingBudget: 0 });
    assert.equal(payload.generationConfig.maxOutputTokens, 3200);
    assert.match(payload.contents[0].parts[0].text, /public internet broadly/);
    return {
      candidates: [{
        finishReason: "STOP",
        content: { parts: [{ text: raw }] },
        groundingMetadata: {
          webSearchQueries: ["English-speaking AI automation consultants Europe"],
          groundingChunks: [{ web: { uri: source, title: "Verified expert" } }],
        },
      }],
      usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 155 },
    };
  } });
  assert.equal(result.provider, "gemini");
  assert.deepEqual(result.candidates.map(c => c.name), ["Verified Professional"]);
  assert.equal(result.candidates[0].contactReviewed, false);
  assert.equal(result.usage.searchRequests, 1);
  assert.equal(result.usage.billingEvidence, undefined,
    "Provider adapter cannot certify complete billable units yet");
  assert.equal(result.reviewRequired, true);
});

test("OpenAI fails closed on missing searches, unsafe citation and incomplete response", async () => {
  const base = {
    status: "completed", output: [
      { type: "web_search_call", status: "completed" },
      { type: "message", role: "assistant", content: [{
        type: "output_text", text: raw, annotations: [],
      }] },
    ],
  };
  const args = { provider: "openai", model: "gpt-4.1-mini",
    apiKey: "openai-test-user-key", query };
  const without = await researchCandidates(args, { post: async () => base });
  assert.deepEqual(without.candidates, []);
  for (const data of [
    { ...base, status: "incomplete" },
    { ...base, output: base.output.slice(1) },
    { ...base, output: Array(4).fill(base.output[0]).concat(base.output[1]) },
  ]) await assert.rejects(() => researchCandidates(args, { post: async () => data }));
});

test("Gemini fails closed when no grounded query ran or response did not finish", async () => {
  const args = { provider: "gemini", model: "gemini-2.5-flash",
    apiKey: "gemini-test-user-key", query };
  const candidateResult = {
    finishReason: "STOP", content: { parts: [{ text: raw }] },
    groundingMetadata: { webSearchQueries: ["Europe experts"], groundingChunks: [] },
  };
  for (const value of [
    { candidates: [{ ...candidateResult, finishReason: "MAX_TOKENS" }] },
    { candidates: [{ ...candidateResult, groundingMetadata: {
      webSearchQueries: [], groundingChunks: [] } }] },
    { candidates: [candidateResult, candidateResult] },
  ]) await assert.rejects(() => researchCandidates(args, { post: async () => value }));
});

test("unsupported models and providers are rejected before billable provider calls", async () => {
  let calls = 0;
  const post = async () => { calls++; throw new Error("Unexpected paid request"); };
  for (const [provider, model] of [
    ["openai", "claude-sonnet-4-6"], ["gemini", "gpt-4.1-mini"],
    ["unknown", "research-model"],
  ]) await assert.rejects(() => researchCandidates({
    provider, model, query, apiKey: "test-user-api-key",
  }, { post }));
  assert.equal(calls, 0);
});

test("Gemini 2.5 grounded prompt may contain more than three internal search queries", async () => {
  const queries = Array.from({ length: 8 }, (_, i) => "Consultant search " + i);
  const result = await researchCandidates({
    provider: "gemini", model: "gemini-2.5-flash",
    apiKey: "gemini-test-user-key", query,
  }, { post: async (_url, _headers, payload) => {
    assert.deepEqual(payload.generationConfig.thinkingConfig, { thinkingBudget: 0 });
    return {
      candidates: [{
        finishReason: "STOP",
        content: { parts: [{ text: raw }] },
        groundingMetadata: {
          webSearchQueries: queries,
          groundingChunks: [{ web: { uri: source, title: "Verified expert" } }],
        },
      }],
      usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 155 },
    };
  } });
  assert.deepEqual(result.candidates.map(c => c.name), ["Verified Professional"]);
  assert.equal(result.usage.searchRequests, 8,
    "Research telemetry may count search queries; Gemini 2.5 billing is per grounded prompt");
});

test("Gemini bounded metadata still rejects pathological query and citation arrays", async () => {
  const args = {
    provider: "gemini", model: "gemini-2.5-flash",
    apiKey: "gemini-test-user-key", query,
  };
  const makeResponse = (queries, chunks) => ({
    candidates: [{
      finishReason: "STOP", content: { parts: [{ text: raw }] },
      groundingMetadata: { webSearchQueries: queries, groundingChunks: chunks },
    }],
  });
  await assert.rejects(() => researchCandidates(args, {
    post: async () => makeResponse(Array(101).fill("query"), []),
  }));
  await assert.rejects(() => researchCandidates(args, {
    post: async () => makeResponse(["query"], Array(201).fill({ web: { uri: source } })),
  }));
});

test("third live Gemini shape with STOP and seven candidates but no groundingChunks fails closed", async () => {
  const names = ["Rashad DuPaty", "Allie K. Miller", "Naman Modi",
    "Tod Sacerdoti", "Robert Portillo", "Lilach Bullock", "Jay Mehta"];
  const redirect = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/example";
  const text = "```json\\n" + JSON.stringify({
    candidates: names.map(name => ({
      name, category: "AI_AUTOMATION", sourceUrl: redirect,
      rationale: "A named professional potentially offering AI automation consulting.",
    })),
  }) + "\\n```";
  let calls = 0;
  await assert.rejects(() => researchCandidates({
    provider: "gemini", model: "gemini-2.5-flash",
    apiKey: "test-owner-key", query,
  }, { post: async () => {
    calls++;
    return { candidates: [{
      finishReason: "STOP", content: { parts: [{ text }] },
      groundingMetadata: {
        webSearchQueries: ["AI consulting US", "AI automation Canada",
          "North American AI expert"],
        searchEntryPoint: { renderedContent: "<div>Search links</div>" },
        // Critically: no provider-cited groundingChunks.
      },
    }], usageMetadata: { candidatesTokenCount: 1654 } };
  } }), error => error?.code === "NO_VERIFIABLE_GROUNDING" &&
    error?.phase === "EVIDENCE_VALIDATION");
  assert.equal(calls, 1, "Never retry an already potentially billable search");
});

test("Gemini certifies one priced grounded prompt only with complete provider token totals", async () => {
  const args = { provider: "gemini", model: "gemini-2.5-flash",
    apiKey: "gemini-test-user-key", query };
  const result = {
    candidates: [{
      finishReason: "STOP", content: { parts: [{ text: raw }] },
      groundingMetadata: {
        webSearchQueries: ["a", "b", "c", "d", "e"],
        groundingChunks: [{ web: { uri: source, title: "Expert" } }],
      },
    }],
    usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 155,
      totalTokenCount: 355, thoughtsTokenCount: 0 },
  };
  const verified = await researchCandidates(args, { post: async () => result });
  assert.equal(verified.usage.searchRequests, 5);
  assert.equal(verified.usage.groundedPrompts, 1);
  assert.deepEqual(verified.usage.billingEvidence, {
    source: "provider", complete: true, provider: "gemini",
    contractVersion: "gemini-2.5-google-search-grounded-prompt-v1",
    billingUnit: "grounded_prompts",
  });
  for (const usageMetadata of [
    { ...result.usageMetadata, totalTokenCount: 354 },
    { ...result.usageMetadata, totalTokenCount: undefined },
    { ...result.usageMetadata, thoughtsTokenCount: 2 },
    { ...result.usageMetadata, cachedContentTokenCount: 10 },
    { ...result.usageMetadata, promptTokenCount: -1 },
  ]) {
    const unverified = await researchCandidates(args, {
      post: async () => ({ ...result, usageMetadata }),
    });
    assert.equal(unverified.usage.billingEvidence, undefined);
    assert.equal(unverified.usage.groundedPrompts, undefined);
  }
});
