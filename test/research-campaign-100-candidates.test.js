import test from "node:test";
import assert from "node:assert/strict";
import { planResearchCampaign } from "../server/research-campaign-planner.js";
import { normalizeCampaignObservations } from "../server/research-campaign-observations.js";

test("100+ unique source-linked candidates accumulate across bounded research tasks", () => {
  const plan = planResearchCampaign({
    query: "Find worldwide specialists in AI workflow automation",
    targetCount: 100,
    idempotencyKey: "6c8d3e48-14fc-4f67-b0c1-e70cf9c48fad",
  });
  const seen = new Set();
  let raw = 0;
  for (const task of plan.tasks.slice(0, 13)) {
    const start = task.index * 10;
    const candidates = [];
    const sources = [];
    for (let j = 0; j < task.limit; j++) {
      // First two observations on every batch are repeated public profiles.
      const ordinal = j < 2 ? j : start + j;
      const url = "https://profiles.example.org/experts/" + ordinal;
      candidates.push({ name: "Professional " + ordinal,
        category: "AI_AUTOMATION", sourceUrl: url,
        rationale: "Publicly listed professional working on AI workflow automation." });
      sources.push({ url });
    }
    const rows = normalizeCampaignObservations({ candidates, sources }, task.limit);
    assert.equal(rows.length, task.limit);
    for (const row of rows) {
      seen.add(row.evidenceKey);
      assert.equal(row.status, "UNVERIFIED");
      assert.equal(row.email, undefined);
      assert.ok(row.citationUrl.startsWith("https://profiles.example.org/"));
      raw++;
    }
  }
  assert.equal(raw, 130);
  assert.equal(seen.size, 106);
  assert.ok(seen.size >= plan.targetCount);
  assert.equal(plan.tasks.length, 24);
  assert.equal(plan.sendEnabled, false);
});
