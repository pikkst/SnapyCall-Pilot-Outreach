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

test("STOP-terminal grounded Gemini output with malformed JSON is classified as no usable candidates", async () => {
  const { ResearchStructuredOutputUnavailableError } =
    await import("../server/research-provider-adapters.js");
  const args = { provider: "gemini", model: "gemini-2.5-flash",
    apiKey: "test-user-key", query };
  for (const text of [
    "Here are several people with profiles, but I cannot produce JSON.",
    JSON.stringify({ candidates: "not an array" }),
  ]) {
    let attempts = 0;
    await assert.rejects(() => researchCandidates(args, {
      post: async () => {
        attempts++;
        return { candidates: [{ finishReason: "STOP",
          content: { parts: [{ text }] },
          groundingMetadata: { webSearchQueries: ["public experts"],
            groundingChunks: [{ web: { uri: source, title: "Public profile" } }] },
        }] };
      },
    }), error => error instanceof ResearchStructuredOutputUnavailableError &&
      error.code === "NO_USABLE_STRUCTURED_OUTPUT" &&
      error.phase === "EVIDENCE_VALIDATION");
    assert.equal(attempts, 1);
  }
});

test("truncated Gemini output or invalid provider envelope never qualifies as safe terminal completion", async () => {
  const args = { provider: "gemini", model: "gemini-2.5-flash",
    apiKey: "test-user-key", query };
  const make = finishReason => ({ candidates: [{
    finishReason,
    content: { parts: [{ text: "not JSON" }] },
    groundingMetadata: { webSearchQueries: ["public expert"],
      groundingChunks: [{ web: { uri: source } }] },
  }] });
  await assert.rejects(() => researchCandidates(args, {
    post: async () => make("MAX_TOKENS"),
  }), error => error.code !== "NO_USABLE_STRUCTURED_OUTPUT");
  await assert.rejects(() => researchCandidates(args, {
    post: async () => ({ candidates: [{ ...make("STOP").candidates[0],
      groundingMetadata: null }] }),
  }), error => error.code === "NO_VERIFIABLE_GROUNDING");
});

test("Gemini 3 Flash preview uses supported minimal thinking and never certifies 2.5 tariffs", async () => {
  const result = await researchCandidates({
    provider: "gemini", model: "gemini-3-flash-preview",
    apiKey: "gemini-test-user-key", query,
  }, { post: async (url, headers, payload) => {
    assert.match(url, /models\/gemini-3-flash-preview:generateContent$/);
    assert.equal(headers["x-goog-api-key"], "gemini-test-user-key");
    assert.deepEqual(payload.tools, [{ google_search: {} }]);
    assert.deepEqual(payload.generationConfig.thinkingConfig, { thinkingLevel: "minimal" });
    assert.equal(payload.generationConfig.maxOutputTokens, 3200);
    return {
      candidates: [{
        finishReason: "STOP",
        content: { parts: [{ text: raw }] },
        groundingMetadata: {
          webSearchQueries: ["consultant US", "expert Canada"],
          groundingChunks: [{ web: { uri: source, title: "Provider-backed source" } }],
        },
      }],
      usageMetadata: {
        promptTokenCount: 200, candidatesTokenCount: 155,
        thoughtsTokenCount: 0, totalTokenCount: 355,
      },
    };
  } });
  assert.deepEqual(result.candidates.map(c => c.name), ["Verified Professional"]);
  assert.equal(result.usage.searchRequests, 2);
  assert.equal(result.usage.billingEvidence, undefined,
    "Never certify Gemini 3 query-based billing as the 2.5 grounded-prompt tariff");
  assert.equal(result.usage.groundedPrompts, undefined);
  assert.equal(result.sendingEnabled, false);
});

const textOnlyManifestFixture = async () => {
  const { buildBoundedRetrievalManifest } = await import("../server/research-evidence.js");
  return buildBoundedRetrievalManifest({
    provider: "contract_test",
    observedAt: "2026-11-18T00:00:00.000Z",
    records: [{
      sourceId: "profile-1",
      url: "https://consultants.example.org/experts/verified",
      title: "Verified professional profile",
      excerpt: "Verified Professional offers AI automation consultation.",
    }],
  });
};

test("Gemini 3 text-only contract has no search tools, external call or browser URL", async () => {
  const { buildGemini3TextOnlyPayload } =
    await import("../server/research-provider-adapters.js");
  const manifest = await textOnlyManifestFixture();
  const payload = buildGemini3TextOnlyPayload({ query, limit: 3, manifest });
  assert.equal(Object.hasOwn(payload, "tools"), false);
  assert.deepEqual(payload.generationConfig.thinkingConfig, { thinkingLevel: "minimal" });
  assert.equal(payload.generationConfig.maxOutputTokens, 2048);
  assert.equal(payload.generationConfig.responseMimeType, "application/json");
  const prompt = payload.contents[0].parts[0].text;
  assert.match(prompt, /profile-1/);
  assert.match(prompt, /untrusted public search excerpts/);
  assert.doesNotMatch(prompt, /x-goog-api-key|google_search/);
});

test("Gemini 3 text-only result binds source IDs, not model-created email or URLs", async () => {
  const { parseGemini3TextOnlyResponse } =
    await import("../server/research-provider-adapters.js");
  const manifest = await textOnlyManifestFixture();
  const result = parseGemini3TextOnlyResponse({
    manifest, limit: 3,
    response: {
      candidates: [{
        finishReason: "STOP",
        content: { parts: [{ text: JSON.stringify({ candidates: [{
          name: "Verified Professional", category: "AI_AUTOMATION",
          sourceId: "profile-1", rationale: "Public source describes consulting expertise",
        }, {
          name: "Invented Person", category: "AI_AUTOMATION",
          sourceId: "invented-id", rationale: "Unverified model suggestion only",
        }] }) }] },
      }],
      usageMetadata: { promptTokenCount: 250, candidatesTokenCount: 125, thoughtsTokenCount: 0 },
    },
  });
  assert.deepEqual(result.candidates.map(x => x.name), ["Verified Professional"]);
  assert.equal(result.candidates[0].sourceUrl, "https://consultants.example.org/experts/verified");
  assert.equal(result.candidates[0].email, null);
  assert.equal(result.imported, false);
  assert.equal(result.reviewRequired, true);
  assert.equal(result.sendingEnabled, false);
  assert.equal(result.usage.searchRequests, 0);
  assert.equal(Object.hasOwn(result.usage, "billingEvidence"), false);
});

test("Gemini text-only response rejects generated search metadata and incomplete results", async () => {
  const { parseGemini3TextOnlyResponse, buildGemini3TextOnlyPayload } =
    await import("../server/research-provider-adapters.js");
  const manifest = await textOnlyManifestFixture();
  const base = {
    candidates: [{ finishReason: "STOP", content: {
      parts: [{ text: '{"candidates":[]}' }],
    } }],
  };
  for (const response of [
    { ...base, candidates: [{ ...base.candidates[0], finishReason: "MAX_TOKENS" }] },
    { ...base, candidates: [{ ...base.candidates[0], groundingMetadata: { webSearchQueries: [] } }] },
    { ...base, candidates: [base.candidates[0], base.candidates[0]] },
    { ...base, candidates: [{ ...base.candidates[0], content: { parts: [] } }] },
  ]) assert.throws(() => parseGemini3TextOnlyResponse({
    manifest, limit: 3, response,
  }));
  assert.throws(() => buildGemini3TextOnlyPayload({
    query: "tiny", limit: 3, manifest,
  }), TypeError);
  assert.throws(() => buildGemini3TextOnlyPayload({
    query, limit: 3, manifest: { ...manifest, digest: "0".repeat(64) },
  }), TypeError);
});


test("bounded Tavily request disables generation, raw fetch and automatic expansion", async () => {
  const { buildBoundedTavilySearchRequest } =
    await import("../server/research-provider-adapters.js");
  const request = buildBoundedTavilySearchRequest({
    query, maxResults: 3,
  });
  assert.deepEqual(request, {
    query, search_depth: "basic", topic: "general", max_results: 3,
    include_answer: false, include_raw_content: false, include_images: false,
    auto_parameters: false, include_usage: true,
  });
  assert.equal(Object.isFrozen(request), true);
  for (const input of [
    { query: "short", maxResults: 2 },
    { query, maxResults: 21 },
    { query, maxResults: 0 },
    { query, maxResults: "3" },
  ]) assert.throws(() => buildBoundedTavilySearchRequest(input), TypeError);
});

test("bounded Tavily normalization yields only provider-returned HTTPS evidence", async () => {
  const { normalizeBoundedTavilySearch, buildGemini3TextOnlyPayload } =
    await import("../server/research-provider-adapters.js");
  const observedAt = "2026-11-18T00:00:00.000Z";
  const result = normalizeBoundedTavilySearch({
    maxResults: 3, observedAt,
    response: {
      results: [
        { url: "https://consultants.example.org/experts/verified#bio",
          title: "Expert profile",
          content: "Verified Professional provides AI automation services." },
        { url: "https://consultants.example.org/experts/verified",
          title: "Duplicate result", content: "Duplicate snippet." },
        { url: "https://127.0.0.1/private",
          title: "Unsafe source", content: "Do not use." },
      ],
      usage: { credits: 1 },
    },
  });
  assert.equal(result.status, "EVIDENCE_AVAILABLE");
  assert.equal(result.manifest.records.length, 1);
  assert.equal(result.manifest.records[0].sourceProvider, "tavily");
  assert.equal(result.manifest.records[0].url,
    "https://consultants.example.org/experts/verified");
  assert.equal(result.manifest.records[0].sourceId.length, 64);
  assert.equal(result.reportedCredits, 1);
  assert.equal(result.billableCallPossible, true);
  const prompt = buildGemini3TextOnlyPayload({
    query, limit: 3, manifest: result.manifest,
  });
  assert.equal(Object.hasOwn(prompt, "tools"), false);
});

test("empty or unsafe Tavily response never produces a manifest for Gemini", async () => {
  const { normalizeBoundedTavilySearch } =
    await import("../server/research-provider-adapters.js");
  for (const results of [
    [], [{ url: "http://example.org", title: "Invalid",
      content: "Unsafe URL." }],
    [{ url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/unsafe",
      title: "Opaque", content: "Unresolved Google link." }],
  ]) {
    const output = normalizeBoundedTavilySearch({
      response: { results }, maxResults: 2,
      observedAt: "2026-11-18T00:00:00.000Z",
    });
    // A remote request may have been charged even if it produced no evidence.
    assert.equal(output.status, "NO_USABLE_EVIDENCE");
    assert.equal(output.manifest, null);
    assert.equal(output.billableCallPossible, true);
    assert.equal(output.reportedCredits, null);
  }
});

test("oversized or invalid Tavily envelope fails before accepting any results", async () => {
  const { normalizeBoundedTavilySearch } =
    await import("../server/research-provider-adapters.js");
  const entry = {
    url: "https://consultants.example.org/a",
    title: "Professional", content: "Professional profile description",
  };
  for (const [response, maxResults] of [
    [{ results: [entry, entry] }, 1],
    [{ results: "invalid" }, 2],
    [null, 2],
    [{ results: [entry] }, 21],
  ]) assert.throws(() => normalizeBoundedTavilySearch({
    response, maxResults, observedAt: "2026-11-18T00:00:00.000Z",
  }), TypeError);
  const result = normalizeBoundedTavilySearch({
    response: { results: [entry], usage: { credits: "1" } },
    maxResults: 1, observedAt: "2026-11-18T00:00:00.000Z",
  });
  assert.equal(result.reportedCredits, null);
});


test("bounded research stages compose without external calls or contact promotion", async () => {
  const { buildBoundedTavilySearchRequest, normalizeBoundedTavilySearch,
    buildGemini3TextOnlyPayload, parseGemini3TextOnlyResponse } =
    await import("../server/research-provider-adapters.js");
  const { calculateCombinedRetrievalAndTextCeilingCents,
    requireResearchPriceEnvelope, ResearchPricingUnavailable } =
    await import("../server/research-price-policy.js");

  const retrievalRequest = buildBoundedTavilySearchRequest({
    query, maxResults: 2,
  });
  const trustedSearch = {
    results: [{
      url: source,
      title: "Professional profile",
      content: "Verified Professional offers AI automation consultancy.",
    }],
    usage: { credits: 1 },
  };
  // Fully deterministic provider fixture: no fetch, credentials or payment.
  const retrieval = normalizeBoundedTavilySearch({
    response: trustedSearch,
    maxResults: retrievalRequest.max_results,
    observedAt: "2026-11-18T00:00:00.000Z",
  });
  const request = buildGemini3TextOnlyPayload({
    query, limit: 2, manifest: retrieval.manifest,
  });
  assert.equal(Object.hasOwn(request, "tools"), false);
  const sourceId = retrieval.manifest.records[0].sourceId;
  const response = {
    candidates: [{
      finishReason: "STOP",
      content: { parts: [{ text: JSON.stringify({ candidates: [
        { name: "Verified Professional", category: "AI_AUTOMATION",
          sourceId, rationale: "Professional publicly offers consulting services" },
        { name: "Fabricated Expert", category: "AI_AUTOMATION",
          sourceId: "not-in-manifest",
          rationale: "No independently observed professional profile" },
      ] }) }] },
    }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 70,
      thoughtsTokenCount: 0 },
  };
  const extracted = parseGemini3TextOnlyResponse({
    response, limit: 2, manifest: retrieval.manifest,
  });
  assert.deepEqual(extracted.candidates.map(c => c.name), ["Verified Professional"]);
  assert.equal(extracted.candidates[0].email, null);
  assert.equal(extracted.candidates[0].contactReviewed, false);
  assert.equal(extracted.candidates[0].status, "REVIEW_PENDING");
  assert.equal(extracted.manifestDigest, retrieval.manifest.digest);
  assert.equal(extracted.imported, false);
  assert.equal(extracted.sendingEnabled, false);

  // A synthetic mathematical ceiling is never a server-approved tariff.
  const quote = calculateCombinedRetrievalAndTextCeilingCents({
    retrieval: { maxRequests: 1, centsPerThousandRequests: 500 },
    textModel: {
      maxInputTokens: 1200, maxOutputTokens: 2048,
      inputCentsPerMillion: 50, outputCentsPerMillion: 300,
    },
  });
  assert.equal(quote.enforcementReady, false);
  assert.ok(quote.worstCaseCents > 0);
  assert.throws(() => requireResearchPriceEnvelope({
    provider: "gemini", model: "gemini-3-flash-preview",
    ...quote,
  }), ResearchPricingUnavailable);
});
