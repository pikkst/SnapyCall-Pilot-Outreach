import test from "node:test";
import assert from "node:assert/strict";
import { normalizeManualResearchSources, enqueueManualResearchSources }
  from "../server/research-manual-sources.js";

test("manual source queue normalizes, deduplicates and strips fragments", () => {
  assert.deepEqual(normalizeManualResearchSources({ urls: [
    " https://example.org/profile/ada#bio ", "https://example.org/profile/ada",
    "https://example.org/profile/ben",
  ] }), [
    "https://example.org/profile/ada", "https://example.org/profile/ben",
  ]);
});

test("manual source queue refuses unsafe, redirect and oversized sources atomically", () => {
  for (const url of [
    "http://example.org", "https://localhost/admin", "https://127.0.0.1/",
    "https://user:password@example.org",
    "https://[::1]/", "https://example.org:444/a",
    "https://vertexaisearch.cloud.google.com/grounding-api-redirect/fake",
  ]) {
    assert.throws(() => normalizeManualResearchSources({ urls: [
      "https://example.org/good", url,
    ] }));
  }
  assert.throws(() => normalizeManualResearchSources({ urls: [] }));
  assert.throws(() => normalizeManualResearchSources({ urls: Array(26).fill("https://example.org") }));
  assert.throws(() => normalizeManualResearchSources({ urls: ["https://example.org", "not-a-url"] }));
});

test("transaction serializes owner-scoped source inserts and never calls a provider", async () => {
  const actions = [];
  const tx = {
    $queryRaw: async () => { actions.push("campaign-locked"); return [{ id: "campaign" }]; },
    researchCampaignSource: {
      createMany: async ({ data, skipDuplicates }) => {
        actions.push("insert");
        assert.equal(skipDuplicates, true);
        assert.deepEqual(data.map(({ normalizedUrlHash: _hash, ...rest }) => rest),
          [{ campaignId: "campaign", normalizedUrl: "https://example.org/ada" }]);
        assert.match(data[0].normalizedUrlHash, /^[a-f0-9]{64}$/);
        return { count: 1 };
      },
    },
    auditEvent: { create: async ({ data }) => {
      actions.push("audit");
      assert.equal(data.action, "research.campaign.manual-sources.queued");
      assert.equal(data.metadata.providerCallsAuthorized, false);
      assert.equal(JSON.stringify(data.metadata).includes("example.org"), false);
    } },
  };
  const result = await enqueueManualResearchSources(tx, {
    campaignId: "campaign", workspaceId: "workspace", ownerId: "owner",
    urls: ["https://example.org/ada"],
  });
  assert.deepEqual(result, { found: true, added: 1, submitted: 1 });
  assert.deepEqual(actions, ["campaign-locked", "insert", "audit"]);
});

test("unauthorized campaign cannot create source records or audit events", async () => {
  let wrote = false;
  const tx = {
    $queryRaw: async () => [],
    researchCampaignSource: { createMany: async () => { wrote = true; } },
    auditEvent: { create: async () => { wrote = true; } },
  };
  assert.deepEqual(await enqueueManualResearchSources(tx, {
    campaignId: "other", workspaceId: "current", ownerId: "user",
    urls: ["https://example.org/ada"],
  }), { found: false, added: 0 });
  assert.equal(wrote, false);
});
