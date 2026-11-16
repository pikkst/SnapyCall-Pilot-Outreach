import test from "node:test";
import assert from "node:assert/strict";
import { normalizeManualLeadSeed } from "../server/manual-lead-seed.js";

const input = {
  manualSeed: true, name: "  Ada Expert  ", category: "COACHING",
  sourceUrl: "https://professionalsus.com/profile/ada#overview",
};

test("manual lead seed is review-only and normalizes manually entered provenance", () => {
  assert.deepEqual(normalizeManualLeadSeed(input), {
    name: "Ada Expert", category: "COACHING",
    sourceUrl: "https://professionalsus.com/profile/ada",
  });
});

test("seed forbids guessed contacts, review assertions and cross-workspace ownership", () => {
  for (const additional of [
    { email: "ada@example.org" }, { contactReviewed: true },
    { onlineEnglish: true }, { legalBasis: "legitimate interest" },
    { workspaceId: "cdifferent99999999" }, { autoScrape: true },
  ]) assert.throws(() => normalizeManualLeadSeed({ ...input, ...additional }));
});

test("manual seed only accepts ordinary public HTTPS references", () => {
  for (const sourceUrl of [
    "http://professionalsus.com/profile/ada", "https://localhost/lead",
    "https://127.0.0.1/a", "https://[::1]/",
    "https://user:pass@example.org/a", "https://example.org:444/a",
    "https://service.internal/a", "https://service.invalid/a",
    "https://no-dot", "javascript:alert(1)",
  ]) assert.throws(() => normalizeManualLeadSeed({ ...input, sourceUrl }), sourceUrl);
});

test("manual seed is limited to existing expert categories", () => {
  assert.throws(() => normalizeManualLeadSeed({ ...input, category: "UNVERIFIED" }));
  assert.throws(() => normalizeManualLeadSeed({ ...input, name: "" }));
});


test("a human-reviewed AI suggestion uses existing manual intake without privileged fields", () => {
  const geminiPreview = {
    name: "Independent Expert",
    category: "AI_AUTOMATION",
    sourceUrl: "https://profiles.example.org/consultant",
    rationale: "AI-suggested description is not independently verified.",
    email: null,
    contactReviewed: false,
    status: "REVIEW_PENDING",
  };
  const reviewedInput = {
    manualSeed: true,
    name: geminiPreview.name,
    category: geminiPreview.category,
    sourceUrl: geminiPreview.sourceUrl,
  };
  assert.deepEqual(normalizeManualLeadSeed(reviewedInput), {
    name: "Independent Expert",
    category: "AI_AUTOMATION",
    sourceUrl: "https://profiles.example.org/consultant",
  });
  assert.throws(() => normalizeManualLeadSeed({
    ...reviewedInput, rationale: geminiPreview.rationale,
  }), "Unreviewed AI description must not be imported as a trusted field");
});
