import test from "node:test";
import assert from "node:assert/strict";
import { verifyPersonSourceProposal }
  from "../server/research-person-source-evidence.js";
import { observationInspectionSource, inspectCampaignObservationEmail }
  from "../server/research-observation-email.js";
import { summarizeQualifiedEmailEvidence }
  from "../server/research-qualified-evidence.js";
import { personSourceFingerprint }
  from "../server/research-person-source-queue.js";

const scope = {
  campaignId: "cmabcdefghijklmnopqrstu",
  workspaceId: "cmabcdefghijklmnopqrstv",
  ownerId: "cmabcdefghijklmnopqrstw",
  jobId: "cmabcdefghijklmnopqrs2",
};
const url = "https://example.org/experts/ada-lovelace";
const clock = new Date("2026-11-18T15:00:00Z");
const observation = {
  id: "cmabcdefghijklmnopqrs1", name: "Ada Lovelace",
  category: "AI_AUTOMATION",
  citationUrl: "https://example.org/team",
  groundingStatus: "UNCHECKED", groundingResolvedUrl: null,
  groundingProvenance: null, emailTriageStatus: "BLOCKED",
  emailTriageCode: "SHARED_SOURCE_REQUIRES_REVIEW",
  emailTriageLeaseToken: null, candidateId: null,
  personSourceUrl: null, personSourceProvenance: null,
  personSourceVerifiedAt: null,
  emailTriageEmail: null, emailTriageDigest: null, emailTriageAt: null,
};
const job = {
  id: scope.jobId, campaignId: scope.campaignId,
  observationId: observation.id,
  evidenceFingerprint: personSourceFingerprint(observation),
  proposedSourceUrl: url, status: "COMPLETED", cycleIndex: 0,
};
function fixture({ approval = true, shared = false,
  memberAfterFetch = true, original = observation,
  continuation = false, fullStopped = false } = {}) {
  const events = [];
  const state = { row: { ...original },
    job: { ...job, cycleIndex: continuation ? 1 : 0 }, fetched: 0 };
  const approve = {
    campaignId: scope.campaignId, workspaceId: scope.workspaceId,
    ownerId: scope.ownerId,
    status: continuation ? "PARTIAL_BUDGET" : "RUNNING",
    publicInspectionAuthorized: approval,
    expiresAt: new Date("2026-11-19T15:00:00Z"),
  };
  const cycle = {
    ...approve, status: "RUNNING", cycleIndex: 1,
  };
  const fullRun = {
    ...approve, status: fullStopped ? "STOPPED" : "SOURCE_RUNNING",
    publicInspectionAuthorized: true,
  };
  const db = {
    researchPersonSourceCycle: { findUnique: async () => cycle },
    researchFullRun: { findUnique: async () => fullRun },
    partnerMembership: {
      findUnique: async () => ({
        id: "member-id", role: "MEMBER", revokedAt: null,
        user: { id: scope.ownerId, googleSub: "google-user-id" },
      }),
    },
    researchCampaign: {
      findFirst: async () => ({ id: scope.campaignId }),
    },
    researchPersonSourceApproval: {
      findUnique: async () => approve,
    },
    researchPersonSourceJob: {
      findFirst: async () => state.job,
      count: async () => shared ? 1 : 0,
    },
    researchCampaignObservation: {
      findFirst: async () => state.row,
      count: async () => 0,
    },
    $transaction: async fn => fn({
      $queryRaw: async chunks => {
        const sql = chunks.join("?");
        if (sql.includes('FROM "PartnerMembership"'))
          return memberAfterFetch ? [{ revokedAt: null }] : [];
        if (sql.includes('FROM "ResearchCampaign"')) return [{ id: scope.campaignId }];
        throw new Error("Unexpected SQL");
      },
      researchPersonSourceApproval: {
        findUnique: async () => approve,
      },
      researchPersonSourceCycle: { findUnique: async () => cycle },
      researchFullRun: { findUnique: async () => fullRun },
      researchPersonSourceJob: {
        findFirst: async () => state.job,
        count: async () => shared ? 1 : 0,
        updateMany: async ({ data }) => {
          events.push("job");
          Object.assign(state.job, data);
          return { count: 1 };
        },
      },
      researchCampaignObservation: {
        findFirst: async () => state.row,
        count: async () => 0,
        updateMany: async ({ data }) => {
          events.push("evidence");
          Object.assign(state.row, data);
          return { count: 1 };
        },
      },
      auditEvent: { create: async ({ data }) => {
        events.push("audit");
        assert.equal(data.metadata.contactCreated, false);
        assert.equal(data.metadata.sendingEnabled, false);
        assert.equal(JSON.stringify(data.metadata).includes("ada@example"), false);
      } },
    }),
  };
  return { db, state, events, retrieve: async input => {
    assert.equal(input, url);
    state.fetched++;
    return { url, text: "Name: Ada Lovelace Email: ada@example.org" };
  } };
}

test("verified public name-email association is counted, not accepted/sent", async () => {
  const f = fixture();
  const result = await verifyPersonSourceProposal(f.db, scope, {
    retrieve: f.retrieve, now: () => clock,
  });
  assert.equal(result.code, "NAMED_EMAIL_EVIDENCE_REVIEW_REQUIRED");
  assert.equal(result.qualifiedEvidence, true);
  assert.equal(result.contactCreated, false);
  assert.equal(result.sendingEnabled, false);
  assert.equal(f.state.row.emailTriageEmail, "ada@example.org");
  assert.equal(f.state.row.personSourceUrl, url);
  assert.equal(observationInspectionSource(f.state.row), url);
  assert.equal(summarizeQualifiedEmailEvidence([f.state.row]).qualifiedEvidence, 1);
  assert.equal(f.state.job.status, "VERIFIED");
  assert.deepEqual(f.events, ["evidence", "job", "audit"]);
  const replay = await verifyPersonSourceProposal(f.db, scope, {
    retrieve: f.retrieve, now: () => clock,
  });
  assert.equal(replay.code, "PERSON_SOURCE_ALREADY_VERIFIED");
  assert.equal(f.state.fetched, 1);
});

test("provider citation is not enough without separately authorized public read", async () => {
  const f = fixture({ approval: false });
  const result = await verifyPersonSourceProposal(f.db, scope, {
    retrieve: f.retrieve, now: () => clock,
  });
  assert.equal(result.code, "PUBLIC_INSPECTION_NOT_AUTHORIZED");
  assert.equal(f.state.fetched, 0);
  assert.deepEqual(f.events, []);
});

test("source collision is rejected before any page request", async () => {
  const f = fixture({ shared: true });
  const result = await verifyPersonSourceProposal(f.db, scope, {
    retrieve: f.retrieve, now: () => clock,
  });
  assert.equal(result.code, "SHARED_SOURCE_REQUIRES_REVIEW");
  assert.equal(f.state.fetched, 0);
  assert.deepEqual(f.events, []);
});

test("unattributed or ambiguous emails never qualify as person evidence", async () => {
  for (const text of [
    "Ada Lovelace ada@example.org",
    "Name: Ada Lovelace Email: info@example.org",
    "Name: Ada Lovelace Email: ada@example.org other@example.org",
  ]) {
    const f = fixture();
    const result = await verifyPersonSourceProposal(f.db, scope, {
      retrieve: async () => ({ url, text }), now: () => clock,
    });
    assert.equal(result.qualifiedEvidence, false);
    assert.equal(f.state.row.emailTriageEmail, null);
    assert.equal(f.state.row.personSourceUrl, null);
    assert.equal(f.state.job.status, "SOURCE_NOT_ATTRIBUTABLE");
    assert.deepEqual(f.events, ["job", "audit"]);
  }
});

test("revocation after external read prevents storing private email evidence", async () => {
  const f = fixture({ memberAfterFetch: false });
  const result = await verifyPersonSourceProposal(f.db, scope, {
    retrieve: f.retrieve, now: () => clock,
  });
  assert.equal(result.code, "WORKSPACE_ACCESS_REVOKED");
  assert.equal(f.state.row.emailTriageEmail, null);
  assert.deepEqual(f.events, []);
});

test("identity changed after independent read is never accepted", async () => {
  const f = fixture();
  const fetchPage = async () => {
    f.state.row.name = "Another Person";
    return { url, text: "Name: Ada Lovelace Email: ada@example.org" };
  };
  const result = await verifyPersonSourceProposal(f.db, scope, {
    retrieve: fetchPage, now: () => clock,
  });
  assert.equal(result.code, "SOURCE_OBSERVATION_CHANGED");
  assert.deepEqual(f.events, []);
  assert.equal(f.state.row.emailTriageEmail, null);
});

test("opaque or forged proposal cannot authorize fetching a profile", async () => {
  const f = fixture();
  f.state.job.proposedSourceUrl =
    "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc";
  const result = await verifyPersonSourceProposal(f.db, scope, {
    retrieve: f.retrieve, now: () => clock,
  });
  assert.equal(result.code, "DIRECT_PERSON_SOURCE_REQUIRED");
  assert.equal(f.state.fetched, 0);
});

test("existing review intake re-inspects independently verified person source", async () => {
  const f = fixture();
  await verifyPersonSourceProposal(f.db, scope, {
    retrieve: f.retrieve, now: () => clock,
  });
  const result = await inspectCampaignObservationEmail(f.db, {
    campaignId: scope.campaignId, observationId: observation.id,
    workspaceId: scope.workspaceId, ownerId: scope.ownerId,
  }, { retrieve: f.retrieve });
  assert.equal(result.code, "NAMED_EMAIL_EVIDENCE_REVIEW_REQUIRED");
  assert.equal(result.sourceUrl, url);
  assert.equal(result.observedEmail, "ada@example.org");
  assert.equal(result.evidenceDigest, f.state.row.emailTriageDigest);
  assert.equal(result.sendingEnabled, false);
});

test("continuation page evidence is tied to exact active cycle and does not need another user click", async () => {
  const f = fixture({ continuation: true });
  const result = await verifyPersonSourceProposal(f.db, scope, {
    retrieve: f.retrieve, now: () => clock,
  });
  assert.equal(result.code, "NAMED_EMAIL_EVIDENCE_REVIEW_REQUIRED");
  assert.equal(result.qualifiedEvidence, true);
  assert.equal(f.state.row.personSourceUrl, url);
  assert.equal(f.state.fetched, 1);
});

test("stopping full-run revokes continuation public-page reads", async () => {
  const f = fixture({ continuation: true, fullStopped: true });
  const result = await verifyPersonSourceProposal(f.db, scope, {
    retrieve: f.retrieve, now: () => clock,
  });
  assert.equal(result.code, "PUBLIC_INSPECTION_NOT_AUTHORIZED");
  assert.equal(f.state.fetched, 0);
  assert.deepEqual(f.events, []);
});
