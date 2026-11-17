import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  summarizeGemini3TestResponse, GEMINI3_TEST_MODEL,
  GEMINI3_TEST_CONFIRMATION, GEMINI3_TEST_RESERVE_CENTS,
} from "../server/gemini3-one-shot.js";

test("one-shot reads only bounded provider billing telemetry, never contacts", () => {
  const result = summarizeGemini3TestResponse({
    candidates: [{
      finishReason: "STOP", content: { parts: [{ text: "private response" }] },
      groundingMetadata: {
        webSearchQueries: ["one", "two"],
        groundingChunks: [{ web: { uri: "https://example.com/secret" } }],
      },
    }],
    usageMetadata: {
      promptTokenCount: 1400,
      candidatesTokenCount: 600, thoughtsTokenCount: 10,
    },
  });
  assert.equal(result.model, GEMINI3_TEST_MODEL);
  assert.equal(result.searchQueries, 2);
  assert.equal(result.groundingChunks, 1);
  assert.equal(result.inputTokens, 1400);
  assert.equal(result.outputTokens, 600);
  assert.equal(result.thinkingTokens, 10);
  assert.equal(result.estimateUsd,
    Math.round((1400 * 0.50 / 1e6 + 610 * 3 / 1e6 +
      2 * 14 / 1000) * 1e6) / 1e6);
  assert.equal(result.providerInvoiceConfirmed, false);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(GEMINI3_TEST_RESERVE_CENTS, 500);
  assert.equal(GEMINI3_TEST_CONFIRMATION, "RUN_ONE_GEMINI3_PAID_TEST");
});

test("unknown billing metadata yields unknown estimate, never an invented zero bill", () => {
  for (const raw of [null, {}, {
    candidates: [{ finishReason: "MAX_TOKENS" }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 200 },
  }, {
    candidates: [{ finishReason: "STOP",
      groundingMetadata: { webSearchQueries: new Array(101).fill("search") } }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 200 },
  }]) {
    const result = summarizeGemini3TestResponse(raw);
    assert.equal(result.estimateUsd, null);
    assert.equal(result.providerInvoiceConfirmed, false);
  }
});

test("one-shot test route reuses locked ledger, consumes durable marker and never bypasses main price registry", () => {
  const code = readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
  const start = code.indexOf('app.post("/api/discovery/gemini3-one-shot"');
  const end = code.indexOf('app.post("/api/discovery/ai-research"', start);
  assert.ok(start > 0 && end > start);
  const section = code.slice(start, end);
  for (const requirement of [
    "AI_GEMINI3_SINGLE_TEST_ENABLED", "AI_GEMINI3_SINGLE_TEST_OWNER_ID",
    "lockActiveWorkspaceMembership", "reserveResearchLease",
    "reserveOwnerSpend", "reserveResearchAttempt", "GEMINI3_TEST_ACTION",
    "GEMINI3_TEST_ALREADY_USED", "settleOwnerSpend", "releaseResearchLease",
    "requireWorkspaceMembership", "researchCandidates({",
  ]) assert.ok(section.includes(requirement), "Missing contract: " + requirement);
  assert.match(section, /if \(used !== 0\) \{/);
  assert.match(section, /throw Object\.assign\(new Error/);
  assert.doesNotMatch(section, /runOneCampaignTask\(|startApprovedCampaignWorker\(/);
  assert.doesNotMatch(section, /approveCampaignRun\(|sendEmail\(/);
  assert.match(section, /noContactsImported: true, noEmailSent: true/);
});

test("user explicitly confirms exactly one call and cannot retry from this browser", () => {
  const ui = readFileSync(new URL("../web/main.tsx", import.meta.url), "utf8");
  assert.match(ui, /gemini3TestAttempted\.current = true/);
  assert.match(ui, /confirmation: "RUN_ONE_GEMINI3_PAID_TEST"/);
  assert.match(ui, /gemini3TestAttempted\.current \|\| gemini3TestBusy/);
  assert.match(ui, /type="checkbox"/);
  assert.match(ui, /provider charge limit/);
});
