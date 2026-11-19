import test from "node:test";
import assert from "node:assert/strict";
import { buildQualifiedContactManifest, approveQualifiedContactBatch,
  readQualifiedContactManifest, contactBatchFullRunReady }
  from "../server/research-contact-batch.js";

const scope = {
  campaignId: "cmabcdefghijklmnopqrstu",
  workspaceId: "cmabcdefghijklmnopqrstv",
  ownerId: "cmabcdefghijklmnopqrstw",
};
const digest = "a".repeat(64);
const person = (i, overrides = {}) => ({
  id: "cmabcdefghijklmnopqrs" + i,
  name: "Expert Person " + i, category: "AI_AUTOMATION",
  citationUrl: "https://example.org/team/" + i,
  groundingStatus: "UNCHECKED", groundingResolvedUrl: null,
  groundingProvenance: null, personSourceUrl: null,
  personSourceProvenance: null, personSourceVerifiedAt: null,
  emailTriageStatus: "REVIEW_REQUIRED",
  emailTriageCode: "NAMED_EMAIL_EVIDENCE_REVIEW_REQUIRED",
  emailTriageEmail: "expert" + i + "@example.org",
  emailTriageDigest: digest,
  emailTriageAt: new Date("2026-11-18T15:00:00Z"),
  candidateId: null, ...overrides,
});
const rows = [person("1"), person("2")];

test("manifest is deterministic, bounded and omits already-linked contacts", () => {
  const a = buildQualifiedContactManifest(rows);
  const b = buildQualifiedContactManifest([...rows].reverse());
  assert.equal(a.manifestHash, b.manifestHash);
  assert.match(a.manifestHash, /^[a-f0-9]{64}$/);
  assert.equal(a.totalQualified, 2);
  assert.equal(a.selectedCount, 2);
  assert.equal(a.entries[0].email, "expert1@example.org");
  assert.equal(a.sendingEnabled, false);
  assert.equal(buildQualifiedContactManifest([
    rows[0], { ...rows[1], candidateId: "cmexistingcontact123456" },
  ]).selectedCount, 1);
});

test("shared profile, duplicate email, generic address and missing digest do not appear", () => {
  const shared = { ...rows[1], citationUrl: rows[0].citationUrl };
  const duplicate = { ...rows[1], emailTriageEmail: rows[0].emailTriageEmail };
  assert.equal(buildQualifiedContactManifest([rows[0], shared]).selectedCount, 0);
  assert.equal(buildQualifiedContactManifest([rows[0], duplicate]).selectedCount, 0);
  assert.equal(buildQualifiedContactManifest([person("3", {
    emailTriageEmail: "info@example.org",
  })]).selectedCount, 0);
  assert.equal(buildQualifiedContactManifest([person("3", {
    emailTriageDigest: null,
  })]).selectedCount, 0);
});

test("caps the review action at 100, with honest total and stable manifest", () => {
  const many = Array.from({ length: 125 }, (_, i) => person(
    String(i + 1000),
    { id: "cmabcdefghijklmnop" + String(i).padStart(7, "0") },
  ));
  const value = buildQualifiedContactManifest(many);
  assert.equal(value.totalQualified, 125);
  assert.equal(value.selectedCount, 100);
  assert.equal(value.entries.length, 100);
  assert.equal(buildQualifiedContactManifest([...many, ...many])
    .manifestHash, null);
});

function fixture({ currentRows = rows, existingBatch = null,
  revoked = false, status = "PARTIAL", fullRunStatus = null,
  mismatchedFullRun = false } = {}) {
  const calls = [];
  const full = fullRunStatus === null ? null : {
    status: fullRunStatus,
    workspaceId: mismatchedFullRun ? "cmotherworkspaceabcdefgh" : scope.workspaceId,
    ownerId: scope.ownerId,
  };
  const tx = {
    researchFullRun: {
      findUnique: async () => full,
    },
    $queryRaw: async chunks => {
      const sql = chunks.join("?");
      if (sql.includes('FROM "PartnerMembership"'))
        return revoked ? [] : [{ revokedAt: null }];
      if (sql.includes('FROM "ResearchCampaign"'))
        return [{ id: scope.campaignId, status }];
      throw Error("Unexpected SQL");
    },
    researchContactBatch: {
      findUnique: async () => existingBatch,
      create: async ({ data }) => {
        calls.push("batch");
        return { ...data, id: "cmbatchabcdefghijklmnopqrs" };
      },
    },
    researchCampaignObservation: {
      count: async () => currentRows.length,
      findMany: async () => currentRows,
    },
    researchContactBatchItem: {
      createMany: async ({ data }) => {
        calls.push("items");
        assert.equal(data.length, 2);
        assert.equal(data[0].expectedDigest, digest);
      },
    },
    auditEvent: { create: async ({ data }) => {
      calls.push("audit");
      assert.equal(data.metadata.automaticSending, false);
      assert.equal(JSON.stringify(data.metadata).includes("expert1@example"), false);
    } },
  };
  const db = {
    $transaction: fn => fn(tx),
    researchFullRun: { findUnique: async () => full },
    researchCampaign: { findFirst: async () => ({
      id: scope.campaignId, status,
    }) },
    researchCampaignObservation: { findMany: async () => currentRows },
    researchContactBatch: { findUnique: async () => existingBatch },
    partnerMembership: { findUnique: async () => revoked ? null : ({
      id: "membership", role: "MEMBER", revokedAt: null,
      user: { id: scope.ownerId, googleSub: "google-sub" },
    }) },
  };
  return { db, calls };
}

test("one reviewed manifest approval materializes 2 durable independent work items", async () => {
  const manifestHash = buildQualifiedContactManifest(rows).manifestHash;
  const f = fixture();
  const result = await approveQualifiedContactBatch(f.db, {
    ...scope, manifestHash, confirmEveryDisplayedPair: true,
    confirmNoAutomaticSending: true,
  });
  assert.equal(result.code, "CONTACT_BATCH_APPROVED");
  assert.equal(result.count, 2);
  assert.equal(result.sendingEnabled, false);
  assert.deepEqual(f.calls, ["batch", "items", "audit"]);
});

test("stale email, revoked membership and implicit consent fail closed before writes", async () => {
  const manifestHash = buildQualifiedContactManifest(rows).manifestHash;
  const changed = fixture({ currentRows: [
    rows[0], { ...rows[1], emailTriageEmail: "another@example.org" },
  ] });
  const r = await approveQualifiedContactBatch(changed.db, {
    ...scope, manifestHash, confirmEveryDisplayedPair: true,
    confirmNoAutomaticSending: true,
  });
  assert.equal(r.code, "CONTACT_BATCH_MANIFEST_CHANGED");
  assert.deepEqual(changed.calls, []);
  const revoked = fixture({ revoked: true });
  assert.equal((await approveQualifiedContactBatch(revoked.db, {
    ...scope, manifestHash, confirmEveryDisplayedPair: true,
    confirmNoAutomaticSending: true,
  })).code, "WORKSPACE_ACCESS_REVOKED");
  assert.deepEqual(revoked.calls, []);
  await assert.rejects(() => approveQualifiedContactBatch(changed.db, {
    ...scope, manifestHash, confirmEveryDisplayedPair: false,
    confirmNoAutomaticSending: true,
  }), TypeError);
});

test("full-run terminal review is required before list read or final batch approval", async () => {
  const manifestHash = buildQualifiedContactManifest(rows).manifestHash;
  const input = { ...scope, manifestHash, confirmEveryDisplayedPair: true,
    confirmNoAutomaticSending: true };
  for (const active of [
    "DISCOVERY", "EMAIL_TRIAGE", "SOURCE_PREPARE", "SOURCE_RUNNING",
    "NEEDS_REVIEW", "STOPPED",
  ]) {
    const f = fixture({ fullRunStatus: active });
    assert.equal(contactBatchFullRunReady({ status: active }), false);
    const read = await readQualifiedContactManifest(f.db, scope);
    assert.equal(read.code, "FULL_RUN_LIST_NOT_READY", active);
    const approved = await approveQualifiedContactBatch(f.db, input);
    assert.equal(approved.code, "FULL_RUN_LIST_NOT_READY", active);
    assert.deepEqual(f.calls, []);
  }
  for (const terminal of ["PARTIAL", "READY_FOR_REVIEW", "COMPLETED"]) {
    const f = fixture({ fullRunStatus: terminal });
    assert.equal(contactBatchFullRunReady({ status: terminal }), true);
    const read = await readQualifiedContactManifest(f.db, scope);
    assert.equal(read.status, 200);
    assert.equal(read.selectedCount, 2);
    const approved = await approveQualifiedContactBatch(f.db, input);
    assert.equal(approved.code, "CONTACT_BATCH_APPROVED");
    assert.deepEqual(f.calls, ["batch", "items", "audit"]);
  }
  assert.equal(contactBatchFullRunReady(null), true,
    "Legacy campaigns without a full run preserve their existing review flow");
});

test("mismatched full-run ownership blocks approval without modifying contacts", async () => {
  const f = fixture({ fullRunStatus: "READY_FOR_REVIEW",
    mismatchedFullRun: true });
  const result = await approveQualifiedContactBatch(f.db, {
    ...scope, manifestHash: buildQualifiedContactManifest(rows).manifestHash,
    confirmEveryDisplayedPair: true, confirmNoAutomaticSending: true,
  });
  assert.equal(result.code, "FULL_RUN_SCOPE_MISMATCH");
  assert.deepEqual(f.calls, []);
});

test("manifest retains distinct independently scoped emails on one public team page", () => {
  const url = "https://example.org/team";
  const shared = rows.map((row, i) => ({ ...row,
    citationUrl: url, personSourceUrl: url,
    personSourceProvenance: "AI98_EXPLICIT_SCOPED_PERSON_EMAIL_ON_SHARED_SOURCE",
    personSourceVerifiedAt: new Date("2026-11-19T12:00:00Z"),
    emailTriageDigest: (i ? "b" : "a").repeat(64),
  }));
  const a = buildQualifiedContactManifest(shared);
  const b = buildQualifiedContactManifest([...shared].reverse());
  assert.equal(a.totalQualified, 2);
  assert.equal(a.selectedCount, 2);
  assert.equal(a.manifestHash, b.manifestHash);
  assert.equal(a.sendingEnabled, false);
  assert.equal(buildQualifiedContactManifest([
    shared[0], { ...shared[1], emailTriageEmail: shared[0].emailTriageEmail },
  ]).selectedCount, 0);
});

test("a shared URL cannot enter the batch without intact scoped provenance", () => {
  const url = "https://example.org/team";
  const a = { ...rows[0], citationUrl: url, personSourceUrl: url,
    personSourceProvenance: "AI98_EXPLICIT_SCOPED_PERSON_EMAIL_ON_SHARED_SOURCE",
    personSourceVerifiedAt: new Date("2026-11-19T12:00:00Z") };
  const b = { ...rows[1], citationUrl: url };
  const result = buildQualifiedContactManifest([a, b]);
  assert.equal(result.totalQualified, 1);
  assert.equal(result.selectedCount, 1);
  assert.equal(result.entries[0].observationId, a.id);
});
