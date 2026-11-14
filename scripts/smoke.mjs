// End-to-end smoke against a disposable CI PostgreSQL database.
// Never run this script with production DATABASE_URL.
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL?.includes("localhost:5432/pilot_test")) {
  throw new Error("Smoke test requires the disposable CI database");
}
const origin = "http://127.0.0.1:4357";
const env = {
  ...process.env,
  NODE_ENV: "production",
  PORT: "4357",
  ADMIN_EMAIL: "admin@example.test",
  ADMIN_PASSWORD: "integration-only-strong-password",
  ADMIN_PASSWORD_HASH: "",
  SESSION_SIGNING_KEY: randomBytes(32).toString("hex"),
  AI_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  GOOGLE_CLIENT_ID: "ci-test-client.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "ci-only-oauth-client-secret",
  GOOGLE_REDIRECT_URI: "https://smoke.example.org/api/auth/google/callback",
  GOOGLE_DATA_REDIRECT_URI: "https://smoke.example.org/api/partner/google/connect/callback",
  GMAIL_OAUTH_ENABLED: "true",
  GOOGLE_GMAIL_REDIRECT_URI: "https://smoke.example.org/api/partner/google/gmail/callback",
  RESEND_API_KEY: "ci-only-resend-token",
  PARTNER_INVITE_FROM: "SnapyCall <invites@example.test>",
  PILOT_GOOGLE_MOCK: "integration-only",
  // Mirror Render's one-hop trusted reverse proxy for HTTP client identity.
  TRUST_PROXY: "1",
};
const server = spawn(process.execPath,
  ["--import", "./scripts/google-data-smoke-mock.mjs", "server/index.js"],
  { env, stdio: ["ignore", "pipe", "pipe"] });
let logs = "";
for (const stream of [server.stdout, server.stderr]) {
  stream.on("data", chunk => { logs += chunk.toString(); });
}

// The smoke covers independent operator, partner and follow-up clients in
// a single fast process. Give each phase its own forwarded client IP; do not
// disable or increase the production API rate limiter to make tests pass.
let smokeClientIp = "198.51.100.10";
async function call(path, init = {}) {
  const headers = new Headers(init.headers ?? {});
  headers.set("x-forwarded-for", smokeClientIp);
  return fetch(origin + "/api" + path, { ...init, headers });
}
let cookie;
try {
  let ready = false;
  for (let attempt = 0; attempt < 70; attempt++) {
    if (server.exitCode !== null) break;
    try {
      const response = await call("/ready");
      if (response.status === 200) { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.equal(ready, true, "API server must become ready; " + logs.slice(-1000));

  const home = await fetch(origin + "/");
  assert.equal(home.status, 200, "Authenticated app must serve the React entrypoint");
  const html = await home.text();
  assert.match(html, /SnapyCall Pilot Outreach/);
  assert.match(html, /\/assets\/index-[a-zA-Z0-9_-]+\.js/);
  // Google OAuth production branding requires publicly accessible product,
  // privacy and terms pages on the same application domain.
  for (const [path, required] of [
    ["/about.html", "SnapyCall Pilot Outreach"],
    ["/privacy.html", "Google data and permissions"],
    ["/terms.html", "Terms of Service"],
  ]) {
    const page = await fetch(origin + path);
    assert.equal(page.status, 200, path + " must be public");
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await page.text(), new RegExp(required));
  }
  assert.match(html, /\/privacy\.html/);
  assert.match(html, /\/terms\.html/);

  assert.equal((await call("/candidates")).status, 401);
  assert.equal((await call("/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    email: env.ADMIN_EMAIL, password: "integration-only-strong-password",
  }) })).status, 403, "missing Origin must be rejected");

  const login = await call("/session", { method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ email: env.ADMIN_EMAIL, password: "integration-only-strong-password" }),
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie?.startsWith("pilot_session="));

  // Bootstrap persists a hash and never exposes the plaintext password.
  const { PrismaClient } = await import("@prisma/client");
  const database = new PrismaClient();
  try {
    const admin = await database.adminCredential.findUnique({ where: { id: "admin" } });
    assert.equal(admin.email, env.ADMIN_EMAIL);
    assert.equal(/^\$2[aby]\$12\$/.test(admin.passwordHash), true);
    assert.equal(admin.passwordHash.includes(env.ADMIN_PASSWORD), false);
    const bootstrapAudits = await database.auditEvent.count({ where: { action: "admin.bootstrap.completed" } });
    assert.equal(bootstrapAudits, 1);
  } finally {
    await database.$disconnect();
  }

  // Without any explicitly approved source, free discovery must fail closed.
  assert.equal((await call("/discovery/sources")).status, 401);
  const sourcesResponse = await call("/discovery/sources", { headers: { cookie } });
  assert.equal(sourcesResponse.status, 200);
  const sources = await sourcesResponse.json();
  assert.deepEqual(sources.feeds, []);
  assert.equal(sources.providerCost, 0);
  const unauthorizedScan = await call("/discovery/scan", {
    method: "POST", headers: { cookie, origin, "content-type": "application/json" },
    body: JSON.stringify({ feedUrl: "https://unapproved.example/rss.xml" }),
  });
  assert.equal(unauthorizedScan.status, 403);
  const unauthorizedImport = await call("/discovery/import", {
    method: "POST", headers: { cookie, origin, "content-type": "application/json" },
    body: JSON.stringify({
      feedUrl: "https://unapproved.example/rss.xml", name: "Test Author",
      sourceUrl: "https://unapproved.example/posts/1", category: "COACHING",
      discoveryKey: "a".repeat(64), proof: "forged",
    }),
  });
  assert.equal(unauthorizedImport.status, 403);

  const protectedHeaders = { origin, cookie, "content-type": "application/json" };
  // A source article never qualifies a discovered byline as an expert.
  // Exercise real Prisma persistence, access controls, provenance and audit.
  const { PrismaClient: ReviewPrisma } = await import("@prisma/client");
  const reviewDb = new ReviewPrisma();
  try {
    const discovered = await reviewDb.candidate.create({
      data: {
        discoveryKey: "c".repeat(64),
        name: "['TimidRobot']",
        category: "AI_AUTOMATION",
        sourceUrl: "https://example.org/articles/automation",
        onlineEnglish: false,
        status: "REVIEW_PENDING",
      },
    });
    const reviewPath = "/candidates/" + discovered.id + "/expert-review";
    assert.equal((await call(reviewPath, {
      method: "PATCH", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ expertProfileUrl: "https://example.org/experts/robot",
        region: "US", onlineEnglish: true, profileReviewed: true }),
    })).status, 403, "Profile review must enforce CSRF origin");
    const blocked = await call("/candidates/" + discovered.id + "/draft", {
      method: "POST", headers: protectedHeaders,
    });
    assert.equal(blocked.status, 409, "RSS byline must not draft before profile review");
    const invalid = await call(reviewPath, {
      method: "PATCH", headers: protectedHeaders,
      body: JSON.stringify({ expertProfileUrl: discovered.sourceUrl,
        region: "US", onlineEnglish: true, profileReviewed: true }),
    });
    assert.equal(invalid.status, 400, "Article must not be accepted as independent profile");
    const payload = JSON.stringify({ expertProfileUrl: "https://example.org/experts/robot",
      region: "US", onlineEnglish: true, profileReviewed: true });
    const reviewed = await call(reviewPath, {
      method: "PATCH", headers: protectedHeaders, body: payload,
    });
    assert.equal(reviewed.status, 200, "Review API: " + await reviewed.text());
    const replay = await call(reviewPath, {
      method: "PATCH", headers: protectedHeaders, body: payload,
    });
    assert.equal(replay.status, 200);
    const persisted = await reviewDb.candidate.findUnique({ where: { id: discovered.id } });
    assert.equal(persisted.sourceUrl, discovered.sourceUrl);
    assert.equal(persisted.expertProfileUrl, "https://example.org/experts/robot");
    assert.equal(persisted.profileReviewed, true);
    assert.equal(persisted.name, "TimidRobot");
    assert.equal(persisted.onlineEnglish, true);
    assert.equal(await reviewDb.auditEvent.count({
      where: { action: "discovery.expert.reviewed", entityId: discovered.id },
    }), 1, "Duplicate review cannot write duplicate audits");
    const candidateList = await call("/candidates", { headers: { cookie } });
    const entries = await candidateList.json();
    const row = entries.find(item => item.id === discovered.id);
    assert.equal(row.name, "TimidRobot");
    assert.equal(row.qualification.stage, "QUALIFIED");
    assert.equal(row.qualification.score, null);
    assert.equal(row.outreach.canDraft, false);
    assert.ok(row.outreach.blockers.includes("email_missing"));
    assert.equal((await call("/candidates/" + discovered.id + "/draft", {
      method: "POST", headers: protectedHeaders,
    })).status, 409, "Reviewed profile alone must not unlock paid AI drafting");
  } finally {
    await reviewDb.$disconnect();
  }

  // An invited partner is an independent identity, never an admin alias.
  const partnerDb = new (await import("@prisma/client")).PrismaClient();
  try {
    const inviteUrl = "/admin/partners/invite";
    assert.equal((await call(inviteUrl, { method: "POST", headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ partnerName: "Test Partner", email: "partner@example.org" }) })).status, 401);
    assert.equal((await call(inviteUrl, { method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ partnerName: "Test Partner", email: "partner@example.org" }) })).status, 403);
    const invite = await call(inviteUrl, { method: "POST", headers: protectedHeaders,
      body: JSON.stringify({ partnerName: "Test Partner", email: "partner@example.org" }) });
    assert.equal(invite.status, 201);
    const inviteResult = await invite.json();
    assert.equal(inviteResult.emailStatus, "SENT");
    const firstWorkspace = inviteResult.partnerId;
    const invitationList = await call("/admin/partners/invitations", { headers: { cookie } });
    assert.equal(invitationList.status, 200);
    const invitationState = await invitationList.json();
    assert.equal(invitationState.emailConfigured, true);
    assert.equal(invitationState.invitations[0].status, "SENT");
    const firstMembership = await partnerDb.partnerMembership.findUnique({
      where: { id: inviteResult.membershipId },
    });
    assert.match(firstMembership.inviteProviderId, /^fixture-email-snapycall-invite-/);
    assert.equal(firstMembership.inviteAttempt, 0);
    assert.equal((await call("/admin/partners/invitations", { headers: { cookie: "pilot_partner_session=invalid" } })).status, 401);
    const noOriginResend = await call("/admin/partners/invitations/" + firstMembership.id + "/resend", {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ newAttempt: true }),
    });
    assert.equal(noOriginResend.status, 403);
    const repeatSend = await call("/admin/partners/invitations/" + firstMembership.id + "/resend", {
      method: "POST", headers: protectedHeaders, body: "{}",
    });
    assert.equal(repeatSend.status, 409, "Sent invite requires explicit new attempt");
    // Exact PostgreSQL CAS regression: another request reclaims an expired
    // SENDING lease after this request has read it. A stale newAttempt must
    // not reset that active lease or allocate a different provider key.
    const staleLease = new Date(Date.now() - 20_000);
    const renewedLease = new Date(Date.now() + 120_000);
    await partnerDb.partnerMembership.update({
      where: { id: firstMembership.id },
      data: { inviteStatus: "SENDING", inviteLeaseUntil: staleLease,
        inviteAttemptAt: new Date(Date.now() - 40_000) },
    });
    const staleSnapshot = await partnerDb.partnerMembership.findUnique({
      where: { id: firstMembership.id },
    });
    await partnerDb.partnerMembership.update({
      where: { id: firstMembership.id },
      data: { inviteLeaseUntil: renewedLease },
    });
    const { resetInvitationAttempt } = await import("../server/partner-invitations.js");
    assert.equal(await resetInvitationAttempt(partnerDb, staleSnapshot), false,
      "Concurrent lease renewal must fence stale resend reset");
    const afterRace = await partnerDb.partnerMembership.findUnique({
      where: { id: firstMembership.id },
    });
    assert.equal(afterRace.inviteAttempt, staleSnapshot.inviteAttempt);
    assert.equal(afterRace.inviteLeaseUntil.getTime(), renewedLease.getTime());
    await partnerDb.partnerMembership.update({
      where: { id: firstMembership.id },
      data: { inviteStatus: "SENT", inviteLeaseUntil: null, inviteAttemptAt: null },
    });
    const newAttempt = await call("/admin/partners/invitations/" + firstMembership.id + "/resend", {
      method: "POST", headers: protectedHeaders, body: JSON.stringify({ newAttempt: true }),
    });
    assert.equal(newAttempt.status, 200);
    assert.equal((await newAttempt.json()).emailStatus, "SENT");
    const updatedMembership = await partnerDb.partnerMembership.findUnique({ where: { id: firstMembership.id } });
    assert.equal(updatedMembership.inviteAttempt, 1);
    assert.notEqual(updatedMembership.inviteProviderId, firstMembership.inviteProviderId);
    assert.equal((await call("/admin/partners")).status, 401, "Workspace listing is admin-only");
    const workspaceList = await call("/admin/partners", { headers: { cookie } });
    assert.equal(workspaceList.status, 200);
    assert.ok((await workspaceList.json()).partners.some(p => p.id === firstWorkspace));
    const secondInvite = await call(inviteUrl, { method: "POST", headers: protectedHeaders,
      body: JSON.stringify({ partnerName: "Second workspace", email: "second@example.org" }) });
    assert.equal(secondInvite.status, 201);
    const secondWorkspace = (await secondInvite.json()).partnerId;
    const addMembership = await call(inviteUrl, { method: "POST", headers: protectedHeaders,
      body: JSON.stringify({ partnerId: secondWorkspace, email: "partner@example.org" }) });
    assert.equal(addMembership.status, 201, "Existing Google identity can join another workspace");
    const repeatMembership = await call(inviteUrl, { method: "POST", headers: protectedHeaders,
      body: JSON.stringify({ partnerId: secondWorkspace, email: "partner@example.org" }) });
    assert.equal(repeatMembership.status, 200, "Membership retries must be idempotent");
    assert.equal((await call(inviteUrl, { method: "POST", headers: protectedHeaders,
      body: JSON.stringify({ partnerId: "cnonexistent123456789", email: "new@example.org" }) })).status, 404);
    assert.equal((await call(inviteUrl, { method: "POST", headers: protectedHeaders,
      body: JSON.stringify({ partnerName: "Other workspace", email: "partner@example.org" }) })).status, 409);
    const member = await partnerDb.partnerUser.findUnique({ where: { emailNormalized: "partner@example.org" } });
    assert.ok(member);
    assert.equal(member.googleSub, null, "Inviting alone cannot sign a Google account in");
    // Unit tests validate real Google signatures and OAuth flow; in the HTTP
    // test, simulate an already verified and bound identity in disposable DB.
    await partnerDb.partnerUser.update({ where: { id: member.id },
      data: { googleSub: "google-test-sub" } });
    const { createPartnerSession } = await import("../server/google-auth.js");
    const partnerCookie = "pilot_partner_session=" +
      createPartnerSession(member.id, env.SESSION_SIGNING_KEY);
    const partnerResponse = await call("/partner/session", { headers: { cookie: partnerCookie } });
    assert.equal(partnerResponse.status, 200);
    const partner = await partnerResponse.json();
    assert.equal(partner.authenticated, true);
    assert.deepEqual(partner.partners.map(p => p.name).sort(), ["Second workspace", "Test Partner"]);
    assert.equal(await partnerDb.partnerUser.count({ where: { emailNormalized: "partner@example.org" } }), 1);
    assert.equal(await partnerDb.partnerMembership.count({ where: { userId: member.id } }), 2);
    const firstRetry = await call(inviteUrl, { method: "POST", headers: protectedHeaders,
      body: JSON.stringify({ partnerId: firstWorkspace, email: "partner@example.org" }) });
    assert.equal(firstRetry.status, 200);
    assert.equal((await call("/candidates", { headers: { cookie: partnerCookie } })).status, 403,
      "Partner must select a workspace before reading candidate data");
    // Default-disabled research can never incur provider charges in staging.
    const researchPath = "/discovery/ai-research?workspaceId=" + firstWorkspace;
    const researchBody = JSON.stringify({
      query: "Find online AI automation consultants in English", limit: 10,
    });
    assert.equal((await call(researchPath, {
      method: "POST", headers: { origin, "content-type": "application/json" },
      body: researchBody,
    })).status, 401, "Research requires verified partner session");
    assert.equal((await call(researchPath, {
      method: "POST", headers: { cookie: partnerCookie, "content-type": "application/json" },
      body: researchBody,
    })).status, 403, "Research must honor CSRF origin");
    assert.equal((await call(researchPath, {
      method: "POST", headers: { cookie: partnerCookie, origin, "content-type": "application/json" },
      body: researchBody,
    })).status, 503, "Paid research is disabled until rollout explicitly enabled");
    const privateLeadA = await partnerDb.candidate.create({ data: {
      workspaceId: firstWorkspace, name: "Private partner A", category: "COACHING",
      sourceUrl: "https://example.org/tenant-a",
    } });
    const privateLeadB = await partnerDb.candidate.create({ data: {
      workspaceId: secondWorkspace, name: "Private partner B", category: "COACHING",
      sourceUrl: "https://example.org/tenant-b",
    } });
    const ownListA = await call("/candidates?workspaceId=" + firstWorkspace,
      { headers: { cookie: partnerCookie } });
    assert.equal(ownListA.status, 200);
    const ownA = await ownListA.json();
    assert.deepEqual(ownA.map(row => row.id), [privateLeadA.id]);
    const ownListB = await call("/candidates?workspaceId=" + secondWorkspace,
      { headers: { cookie: partnerCookie } });
    assert.deepEqual((await ownListB.json()).map(row => row.id), [privateLeadB.id]);
    assert.equal((await call("/candidates?workspaceId=" + firstWorkspace, {
      headers: { cookie },
    })).status, 403, "Legacy admin may not impersonate workspace readers");
    assert.equal((await call("/candidates?workspaceId=not-a-cuid", {
      headers: { cookie: partnerCookie },
    })).status, 403);
    assert.equal((await call("/drafts?workspaceId=" + firstWorkspace, {
      headers: { cookie: partnerCookie },
    })).status, 200);
    assert.deepEqual(await (await call("/drafts?workspaceId=" + firstWorkspace, {
      headers: { cookie: partnerCookie },
    })).json(), []);
    // Gary's manual seed workflow: no website crawl, no inferred contact,
    // tenant-scoped identity, CSRF and stable replay with a canonical URL.
    const seedUrl = "/candidates?workspaceId=" + firstWorkspace;
    const manualBody = JSON.stringify({
      manualSeed: true, name: "Alex Public Expert", category: "COACHING",
      sourceUrl: "https://directory.example.org/experts/alex?utm_source=test",
    });
    const manualHeaders = { cookie: partnerCookie, origin,
      "content-type": "application/json" };
    assert.equal((await call(seedUrl, { method: "POST",
      headers: { cookie: partnerCookie, "content-type": "application/json" },
      body: manualBody })).status, 403, "Manual source entry must honor Origin");
    assert.equal((await call("/candidates", { method: "POST",
      headers: protectedHeaders, body: manualBody })).status, 403,
      "Legacy admin is not a Google partner");
    assert.equal((await call("/candidates?workspaceId=" + secondWorkspace, {
      method: "POST", headers: { cookie: partnerCookie, origin,
        "content-type": "application/json" },
      body: JSON.stringify({ ...JSON.parse(manualBody), contactReviewed: true }),
    })).status, 400, "User must not assert outreach authorization in a seed");
    const manualFirst = await call(seedUrl, {
      method: "POST", headers: manualHeaders, body: manualBody,
    });
    assert.equal(manualFirst.status, 201);
    const manualFirstBody = await manualFirst.json();
    assert.equal(manualFirstBody.created, true);
    assert.equal(manualFirstBody.reviewRequired, true);
    assert.equal(manualFirstBody.contactAuthorized, false);
    const manualReplay = await call(seedUrl, {
      method: "POST", headers: manualHeaders,
      body: JSON.stringify({ ...JSON.parse(manualBody),
        sourceUrl: "https://directory.example.org/experts/alex",
      }),
    });
    assert.equal(manualReplay.status, 200, "Canonical replay cannot duplicate a seed");
    assert.equal((await manualReplay.json()).id, manualFirstBody.id);
    const seedRecord = await partnerDb.candidate.findUnique({
      where: { id: manualFirstBody.id },
    });
    assert.equal(seedRecord.workspaceId, firstWorkspace);
    assert.equal(seedRecord.status, "REVIEW_PENDING");
    assert.equal(seedRecord.email, null);
    assert.equal(seedRecord.legalBasis, null);
    assert.equal(seedRecord.profileReviewed, false);
    assert.equal(seedRecord.contactReviewed, false);
    assert.equal(seedRecord.onlineEnglish, false);
    assert.equal((await partnerDb.auditEvent.count({
      where: { entityId: manualFirstBody.id, action: "discovery.manual-seed.created" },
    })), 1, "Replay never writes duplicate audits");
    const otherTenantSeed = await call(
      "/candidates?workspaceId=" + secondWorkspace, {
        method: "POST", headers: manualHeaders, body: manualBody,
      });
    assert.equal(otherTenantSeed.status, 201,
      "The same public professional may be researched in a separate workspace");
    assert.notEqual((await otherTenantSeed.json()).id, manualFirstBody.id);
    assert.equal((await call("/candidates?workspaceId=" + firstWorkspace, {
      method: "POST", headers: protectedHeaders, body: manualBody,
    })).status, 403, "Admin cannot impersonate a partner workspace");
    // Candidate identifiers are tenant-scoped; legacy admin still has
    // unique identifiers within the NULL workspace segment.
    const identityFields = {
      name: "Shared professional", category: "COACHING",
      sourceUrl: "https://example.org/identity-check",
      emailNormalized: "tenancy-identity@example.org",
      discoveryKey: "e".repeat(64),
    };
    const scopedOne = await partnerDb.candidate.create({
      data: { ...identityFields, workspaceId: firstWorkspace },
    });
    const scopedTwo = await partnerDb.candidate.create({
      data: { ...identityFields, workspaceId: secondWorkspace },
    });
    assert.notEqual(scopedOne.id, scopedTwo.id,
      "Different workspaces may import the same public professional");
    const duplicateUrl = "/candidates/" + scopedOne.id + "/possible-duplicates";
    assert.equal((await call(duplicateUrl, {
      headers: { cookie: partnerCookie },
    })).status, 403, "Duplicate hints require explicit workspace selection");
    assert.equal((await call(duplicateUrl + "?workspaceId=" + secondWorkspace, {
      headers: { cookie: partnerCookie },
    })).status, 404, "A foreign candidate ID must not leak identity data");
    assert.equal((await call(duplicateUrl + "?workspaceId=" + firstWorkspace, {
      headers: { cookie },
    })).status, 403, "Legacy admin may not inspect partner identity hints");
    const isolatedHints = await call(duplicateUrl + "?workspaceId=" + firstWorkspace, {
      headers: { cookie: partnerCookie },
    });
    assert.equal(isolatedHints.status, 200);
    assert.deepEqual((await isolatedHints.json()).suggestions, [],
      "Matching email in another workspace is never a duplicate suggestion");
    const sameWorkspaceHint = await partnerDb.candidate.create({ data: {
      workspaceId: firstWorkspace, name: "Same profile, separate evidence",
      category: "COACHING", sourceUrl: "https://example.org/secondary",
      emailNormalized: "separate@example.org",
      expertProfileUrl: "https://example.org/shared-consultant",
    } });
    await partnerDb.candidate.update({ where: { id: scopedOne.id },
      data: { expertProfileUrl: "https://example.org/shared-consultant" },
    });
    const ownHints = await call(duplicateUrl + "?workspaceId=" + firstWorkspace, {
      headers: { cookie: partnerCookie },
    });
    assert.equal(ownHints.status, 200);
    const ownHintBody = await ownHints.json();
    assert.equal(ownHintBody.automaticallyMerged, false);
    assert.deepEqual(ownHintBody.suggestions.map(x => x.id), [sameWorkspaceHint.id],
      "Only verified same-workspace identities are eligible for duplicate hints");
    await partnerDb.candidate.delete({ where: { id: sameWorkspaceHint.id } });

    await assert.rejects(() => partnerDb.candidate.create({
      data: { ...identityFields, workspaceId: firstWorkspace },
    }), error => error?.code === "P2002",
    "Same-workspace duplicate must be rejected by PostgreSQL");
    const legacyFirst = await partnerDb.candidate.create({
      data: { ...identityFields, workspaceId: null },
    });
    assert.ok(legacyFirst.id);
    await assert.rejects(() => partnerDb.candidate.create({
      data: { ...identityFields, workspaceId: null },
    }), error => error?.code === "P2002",
    "Legacy admin NULL ownership retains identifier uniqueness");
    // Expert review stays on the existing endpoint, but must not cross
    // workspace/legacy admin boundaries even when candidate IDs are known.
    const scopedReviewUrl = "/candidates/" + scopedOne.id + "/expert-review";
    const scopedReviewBody = JSON.stringify({
      expertProfileUrl: "https://example.org/expert/verified",
      region: "US", onlineEnglish: true, profileReviewed: true,
    });
    assert.equal((await call(scopedReviewUrl + "?workspaceId=" + firstWorkspace, {
      method: "PATCH", headers: { cookie: partnerCookie, "content-type": "application/json" },
      body: scopedReviewBody,
    })).status, 403, "Expert review requires a valid Origin");
    assert.equal((await call(scopedReviewUrl, {
      method: "PATCH", headers: { cookie: partnerCookie, origin, "content-type": "application/json" },
      body: scopedReviewBody,
    })).status, 403, "Partner must select exact workspace");
    assert.equal((await call(scopedReviewUrl + "?workspaceId=" + secondWorkspace, {
      method: "PATCH", headers: { cookie: partnerCookie, origin, "content-type": "application/json" },
      body: scopedReviewBody,
    })).status, 404, "Foreign workspace candidate cannot be reviewed");
    assert.equal((await call(scopedReviewUrl + "?workspaceId=" + firstWorkspace, {
      method: "PATCH", headers: protectedHeaders, body: scopedReviewBody,
    })).status, 403, "Admin must not impersonate partner scope");
    assert.equal((await call(scopedReviewUrl, {
      method: "PATCH", headers: protectedHeaders, body: scopedReviewBody,
    })).status, 404, "Legacy admin cannot review partner-owned candidate");
    const scopedReview = await call(scopedReviewUrl + "?workspaceId=" + firstWorkspace, {
      method: "PATCH", headers: { cookie: partnerCookie, origin, "content-type": "application/json" },
      body: scopedReviewBody,
    });
    assert.equal(scopedReview.status, 200);
    assert.deepEqual(await scopedReview.json(), { status: 200, reviewed: true, changed: true });
    const reviewedScoped = await partnerDb.candidate.findUnique({ where: { id: scopedOne.id } });
    assert.equal(reviewedScoped.workspaceId, firstWorkspace);
    assert.equal(reviewedScoped.sourceUrl, identityFields.sourceUrl);
    assert.equal(reviewedScoped.profileReviewed, true);
    assert.equal((await call(scopedReviewUrl + "?workspaceId=" + firstWorkspace, {
      method: "PATCH", headers: { cookie: partnerCookie, origin, "content-type": "application/json" },
      body: scopedReviewBody,
    })).status, 200, "Expert review replay must be idempotent");
    assert.equal(await partnerDb.auditEvent.count({
      where: { action: "discovery.expert.reviewed", actorId: member.id, entityId: scopedOne.id },
    }), 1, "Idempotent review emits only one partner audit event");
    await partnerDb.candidate.deleteMany({
      where: { id: { in: [scopedOne.id, scopedTwo.id, legacyFirst.id] } },
    });
    // Start the independent partner-write test phase as a second client.
    smokeClientIp = "198.51.100.11";
    // Candidate create uses the exact same existing endpoint for admin and
    // Google users. Every partner write must select an active workspace.
    const manualCandidate = {
      name: "Independent coaching expert", category: "COACHING",
      email: "own-lead@example.org", sourceUrl: "https://example.org/expert-profile",
      onlineEnglish: false,
    };
    const submitCandidate = (headers, query = "", body = manualCandidate) =>
      call("/candidates" + query, { method: "POST",
        headers: { origin, "content-type": "application/json", ...headers },
        body: JSON.stringify(body) });
    assert.equal((await submitCandidate({ cookie: partnerCookie })).status, 403,
      "Google partner must explicitly select active workspace");
    assert.equal((await submitCandidate({ cookie: partnerCookie },
      "?workspaceId=cnonexistent123456789")).status, 403);
    assert.equal((await call("/candidates?workspaceId=" + firstWorkspace, {
      method: "POST", headers: { cookie: partnerCookie, "content-type": "application/json" },
      body: JSON.stringify(manualCandidate),
    })).status, 403, "CSRF protection applies to partner writes");
    assert.equal((await submitCandidate({ cookie: partnerCookie },
      "?workspaceId=" + firstWorkspace,
      { ...manualCandidate, workspaceId: secondWorkspace })).status, 400,
      "Untrusted ownership fields must be rejected");
    assert.equal((await submitCandidate({ cookie },
      "?workspaceId=" + firstWorkspace)).status, 403,
      "Legacy admin cannot write into partner workspace");
    const createFirst = await submitCandidate({ cookie: partnerCookie },
      "?workspaceId=" + firstWorkspace);
    assert.equal(createFirst.status, 201);
    const createdFirstId = (await createFirst.json()).id;
    const createdFirst = await partnerDb.candidate.findUnique({ where: { id: createdFirstId } });
    assert.equal(createdFirst.workspaceId, firstWorkspace);
    assert.equal(createdFirst.emailNormalized, "own-lead@example.org");
    assert.equal((await submitCandidate({ cookie: partnerCookie },
      "?workspaceId=" + firstWorkspace)).status, 409,
      "Duplicate email within one workspace is rejected");
    const createSecond = await submitCandidate({ cookie: partnerCookie },
      "?workspaceId=" + secondWorkspace);
    assert.equal(createSecond.status, 201,
      "Different workspaces can independently source the same professional");
    const createdSecondId = (await createSecond.json()).id;
    assert.equal((await partnerDb.candidate.findUnique({
      where: { id: createdSecondId },
    })).workspaceId, secondWorkspace);
    // Existing evidence endpoints must fence workspace identity as strictly as
    // candidate creation. No cross-tenant evidence or audit access is permitted.
    const evidencePath = "/candidates/" + createdFirstId + "/evidence";
    const evidenceBody = JSON.stringify({
      kind: "PROFILE", sourceUrl: "https://example.org/partner-evidence",
      note: "Public source to review",
    });
    assert.equal((await call(evidencePath, {
      headers: { cookie: partnerCookie },
    })).status, 403, "Workspace selection is mandatory for evidence reads");
    assert.equal((await call(evidencePath + "?workspaceId=" + secondWorkspace, {
      headers: { cookie: partnerCookie },
    })).status, 404, "Another workspace must not expose candidate evidence");
    assert.equal((await call(evidencePath + "?workspaceId=" + firstWorkspace, {
      headers: { cookie },
    })).status, 403, "Admin cannot impersonate workspace evidence reader");
    assert.equal((await call(evidencePath + "?workspaceId=" + firstWorkspace, {
      method: "POST", headers: { cookie: partnerCookie, "content-type": "application/json" },
      body: evidenceBody,
    })).status, 403, "Evidence writes require CSRF origin");
    assert.equal((await call(evidencePath + "?workspaceId=" + secondWorkspace, {
      method: "POST", headers: { cookie: partnerCookie, origin, "content-type": "application/json" },
      body: evidenceBody,
    })).status, 404, "Evidence cannot be written into a foreign candidate");
    const ownEvidence = await call(evidencePath + "?workspaceId=" + firstWorkspace, {
      method: "POST", headers: { cookie: partnerCookie, origin, "content-type": "application/json" },
      body: evidenceBody,
    });
    assert.equal(ownEvidence.status, 201);
    const ownEvidenceId = (await ownEvidence.json()).id;
    assert.equal((await call(evidencePath + "?workspaceId=" + firstWorkspace, {
      method: "POST", headers: { cookie: partnerCookie, origin, "content-type": "application/json" },
      body: evidenceBody,
    })).status, 200, "Idempotent evidence replay must not duplicate a source");
    const ownEvidenceList = await call(evidencePath + "?workspaceId=" + firstWorkspace, {
      headers: { cookie: partnerCookie },
    });
    assert.equal(ownEvidenceList.status, 200);
    assert.deepEqual((await ownEvidenceList.json()).map(item => item.id), [ownEvidenceId]);
    assert.equal((await partnerDb.candidateEvidence.findUnique({
      where: { id: ownEvidenceId },
    })).workspaceId, firstWorkspace);
    assert.equal(await partnerDb.auditEvent.count({
      where: { action: "candidate.evidence.added", entityId: createdFirstId, actorId: member.id },
    }), 1);
    await partnerDb.candidateEvidence.delete({ where: { id: ownEvidenceId } });
    const adminCreatedResponse = await submitCandidate({ cookie }, "");
    assert.equal(adminCreatedResponse.status, 201, "Legacy admin create remains working");
    const adminCreatedId = (await adminCreatedResponse.json()).id;
    assert.equal((await partnerDb.candidate.findUnique({
      where: { id: adminCreatedId },
    })).workspaceId, null);
    const isolationAudit = await partnerDb.auditEvent.findMany({
      where: { action: "candidate.created", entityId: { in: [createdFirstId, createdSecondId, adminCreatedId] } },
    });
    assert.equal(isolationAudit.length, 3);
    const partnerAudit = isolationAudit.find(a => a.entityId === createdFirstId);
    assert.equal(partnerAudit.actorId, member.id);
    assert.equal(partnerAudit.metadata.workspaceId, firstWorkspace);
    await partnerDb.candidate.deleteMany({
      where: { id: { in: [createdFirstId, createdSecondId, adminCreatedId] } },
    });
    const legacyList = await call("/candidates", { headers: { cookie } });
    assert.equal(legacyList.status, 200);
    assert.equal((await legacyList.json()).some(row => row.id === privateLeadA.id), false,
      "Legacy admin must not see Google-workspace candidates");

    // Google users configure their own AI keys through the existing endpoint.
    // The admin key is never used as a fallback for a partner session.
    const ownSettings = await call("/ai-settings", { headers: { cookie: partnerCookie } });
    assert.equal(ownSettings.status, 200);
    assert.equal((await ownSettings.json()).keyConfigured, false);
    const keyPayload = JSON.stringify({
      provider: "gemini", model: "gemini-2.5-flash",
      apiKey: "partner-personal-api-key-for-ci",
    });
    assert.equal((await call("/ai-settings", { method: "PUT",
      headers: { cookie: partnerCookie, "content-type": "application/json" },
      body: keyPayload })).status, 403, "Partner key mutation requires CSRF origin");
    const savedOwn = await call("/ai-settings", { method: "PUT",
      headers: { cookie: partnerCookie, origin, "content-type": "application/json" },
      body: keyPayload });
    assert.equal(savedOwn.status, 200);
    const ownMetadata = await call("/ai-settings", { headers: { cookie: partnerCookie } });
    const metadataText = await ownMetadata.text();
    assert.equal(JSON.parse(metadataText).keyConfigured, true);
    assert.equal(metadataText.includes("partner-personal-api-key-for-ci"), false);
    const ownKeyRow = await partnerDb.aiSetting.findUnique({ where: { ownerId: member.id } });
    assert.ok(ownKeyRow);
    assert.notEqual(ownKeyRow.encryptedApiKey, "partner-personal-api-key-for-ci");
    const legacyAdminSettings = await call("/ai-settings", { headers: { cookie } });
    assert.equal((await legacyAdminSettings.json()).keyConfigured, false);
    const ambiguousCookies = await call("/ai-settings", {
      headers: { cookie: cookie + "; " + partnerCookie },
    });
    assert.equal(ambiguousCookies.status, 409,
      "Concurrent admin and partner sessions must not fall back to admin AI key");


    assert.equal((await call("/partner/google/connections")).status, 401,
      "Unauthenticated callers cannot list Google connections");
    assert.equal((await call("/partner/google/connections", { headers: { cookie } })).status, 401,
      "Admin session cannot impersonate a partner");
    const googleList = await call("/partner/google/connections", { headers: { cookie: partnerCookie } });
    assert.equal(googleList.status, 200);
    assert.deepEqual(await googleList.json(), { connections: [], available: true });
    assert.equal((await call("/partner/google/connect/start?partnerId=" + firstWorkspace)).status, 401);

    // The mock is installed only in the disposable subprocess. The real
    // HTTP callback, RS256 verifier, PKCE flow and Prisma persistence run.
    async function beginGoogleConnection(workspaceId, partnerCookieValue) {
      const start = await call("/partner/google/connect/start?partnerId=" + workspaceId, {
        headers: { cookie: partnerCookieValue }, redirect: "manual",
      });
      assert.equal(start.status, 302);
      const location = new URL(start.headers.get("location"));
      assert.equal(location.origin, "https://accounts.google.com");
      const flowCookie = start.headers.get("set-cookie")?.split(";")[0];
      assert.ok(flowCookie?.startsWith("pilot_google_data_flow="));
      return { flowCookie, state: location.searchParams.get("state"),
        nonce: location.searchParams.get("nonce") };
    }

    async function completeGoogleConnection(flow, kind = "good") {
      return call("/partner/google/connect/callback?state=" + flow.state +
        "&code=" + flow.nonce + "%3A" + kind, {
        headers: { cookie: flow.flowCookie }, redirect: "manual",
      });
    }

    for (const kind of ["wrong-sub", "wrong-email"]) {
      const flow = await beginGoogleConnection(firstWorkspace, partnerCookie);
      const rejected = await completeGoogleConnection(flow, kind);
      assert.equal(rejected.status, 403, "Mismatched Google identity must not connect");
      assert.equal(await partnerDb.partnerGoogleConnection.count(), 0);
    }

    const grantedFlow = await beginGoogleConnection(firstWorkspace, partnerCookie);
    const granted = await completeGoogleConnection(grantedFlow);
    assert.equal(granted.status, 303, "Verified callback must persist connection");
    const stored = await partnerDb.partnerGoogleConnection.findUnique({
      where: { partnerId_userId: { partnerId: firstWorkspace, userId: member.id } },
    });
    assert.ok(stored);
    assert.equal(stored.googleSub, "google-test-sub");
    assert.notEqual(stored.encryptedRefreshToken, "fixture-refresh-token-secret-value");
    const { decryptKey } = await import("../server/security.js");
    assert.equal(decryptKey(stored.encryptedRefreshToken, env.AI_ENCRYPTION_KEY),
      "fixture-refresh-token-secret-value");
    const listed = await call("/partner/google/connections", { headers: { cookie: partnerCookie } });
    assert.equal(listed.status, 200);
    const listedBody = await listed.text();
    assert.equal(listedBody.includes("fixture-refresh-token-secret-value"), false);
    assert.equal(listedBody.includes(stored.encryptedRefreshToken), false);
    assert.deepEqual(JSON.parse(listedBody).connections.map(c => c.partnerId), [firstWorkspace]);
    // Gmail sending consent is separate from Forms/Sheets and never sends mail.
    assert.equal((await call("/partner/google/gmail")).status, 401);
    assert.equal((await call("/partner/google/gmail", { headers: { cookie } })).status,
      401, "Admin must not impersonate a Gmail account");
    assert.equal((await call("/partner/google/gmail/start?workspaceId=" + secondWorkspace,
      { headers: { cookie }, redirect: "manual" })).status, 401);
    assert.equal((await call("/partner/google/gmail/start?workspaceId=cnonexistent12345",
      { headers: { cookie: partnerCookie }, redirect: "manual" })).status, 403);
    const initialGmail = await call("/partner/google/gmail", { headers: { cookie: partnerCookie } });
    assert.deepEqual(await initialGmail.json(), {
      available: true, connected: false, email: "partner@example.org", sendingEnabled: false,
    });
    async function beginGmailConsent() {
      const start = await call("/partner/google/gmail/start?workspaceId=" + firstWorkspace,
        { headers: { cookie: partnerCookie }, redirect: "manual" });
      assert.equal(start.status, 302);
      const authUrl = new URL(start.headers.get("location"));
      const scopes = authUrl.searchParams.get("scope");
      assert.match(scopes, /https:\/\/www.googleapis.com\/auth\/gmail.send/);
      assert.equal(scopes.includes("forms.responses.readonly"), false);
      const flowCookie = start.headers.get("set-cookie")?.split(";")[0];
      assert.ok(flowCookie?.startsWith("pilot_google_gmail_flow="));
      return { flowCookie, state: authUrl.searchParams.get("state"),
        nonce: authUrl.searchParams.get("nonce") };
    }
    async function completeGmailConsent(flow, kind = "good") {
      return call("/partner/google/gmail/callback?state=" + flow.state +
        "&code=" + flow.nonce + "%3A" + kind,
        { headers: { cookie: flow.flowCookie }, redirect: "manual" });
    }
    const wrongGmail = await beginGmailConsent();
    assert.equal((await completeGmailConsent(wrongGmail, "wrong-sub")).status, 403);
    assert.equal(await partnerDb.partnerGmailConnection.count(), 0);
    const validGmail = await beginGmailConsent();
    assert.equal((await completeGmailConsent(validGmail)).status, 303);
    const gmailGrant = await partnerDb.partnerGmailConnection.findUnique({
      where: { userId: member.id },
    });
    assert.ok(gmailGrant);
    assert.equal(gmailGrant.googleSub, "google-test-sub");
    assert.equal(gmailGrant.scope.includes("gmail.send"), true);
    assert.equal(decryptKey(gmailGrant.encryptedRefreshToken, env.AI_ENCRYPTION_KEY),
      "fixture-refresh-token-secret-value");
    assert.equal(await partnerDb.partnerGoogleConnection.count(), 1,
      "Gmail grant must not mutate read-only Forms/Sheets connection");
    const gmailResponse = await call("/partner/google/gmail", { headers: { cookie: partnerCookie } });
    const gmailText = await gmailResponse.text();
    assert.equal(gmailText.includes("fixture-refresh-token-secret-value"), false);
    assert.equal(gmailText.includes(gmailGrant.encryptedRefreshToken), false);
    assert.equal(JSON.parse(gmailText).sendingEnabled, false);
    assert.equal(JSON.parse(gmailText).connected, true);


    // A separately invited user may access another workspace but not this
    // user's grant, including via guessed partner IDs.
    const outsiderInvite = await call(inviteUrl, { method: "POST", headers: protectedHeaders,
      body: JSON.stringify({ partnerId: secondWorkspace, email: "outsider@example.org" }) });
    assert.equal(outsiderInvite.status, 201);
    const outsider = await partnerDb.partnerUser.findUnique({
      where: { emailNormalized: "outsider@example.org" },
    });
    await partnerDb.partnerUser.update({ where: { id: outsider.id },
      data: { googleSub: "outsider-google-sub" } });
    const outsiderCookie = "pilot_partner_session=" +
      createPartnerSession(outsider.id, env.SESSION_SIGNING_KEY);
    const outsiderGmail = await call("/partner/google/gmail", { headers: { cookie: outsiderCookie } });
    assert.equal((await outsiderGmail.json()).connected, false);
    assert.equal((await call("/partner/google/gmail", {
      method: "DELETE", headers: { cookie: outsiderCookie, origin },
    })).status, 200);
    assert.equal(await partnerDb.partnerGmailConnection.count(), 1,
      "Another Google account cannot delete the owner's Gmail grant");
    assert.equal((await call("/partner/google/gmail", {
      method: "DELETE", headers: { cookie: partnerCookie },
    })).status, 403, "Gmail disconnect requires a CSRF origin");
    assert.equal((await call("/partner/google/gmail", {
      method: "DELETE", headers: { cookie: partnerCookie, origin },
    })).status, 200);
    assert.equal(await partnerDb.partnerGmailConnection.count(), 0);
    assert.equal(await partnerDb.partnerGoogleConnection.count(), 1,
      "Disconnecting Gmail must not disconnect Forms/Sheets");

    const outsiderSettings = await call("/ai-settings", { headers: { cookie: outsiderCookie } });
    assert.equal((await outsiderSettings.json()).keyConfigured, false,
      "Distinct Google users never inherit another user's AI key");
    assert.equal((await call("/ai-settings", { method: "DELETE", headers: {
      cookie: outsiderCookie, origin,
    } })).status, 200);
    assert.equal((await (await call("/ai-settings", { headers: { cookie: partnerCookie } })).json()).keyConfigured,
      true, "Outsider deletion must not affect another user");
    assert.equal((await call("/ai-settings", { method: "DELETE", headers: {
      cookie: partnerCookie, origin,
    } })).status, 200);
    assert.equal(await partnerDb.aiSetting.count({ where: { ownerId: member.id } }), 0);


    assert.equal((await call("/candidates?workspaceId=" + firstWorkspace, {
      headers: { cookie: outsiderCookie },
    })).status, 403, "Outsider cannot read a different workspace");
    const outsiderOwn = await call("/candidates?workspaceId=" + secondWorkspace,
      { headers: { cookie: outsiderCookie } });
    assert.equal(outsiderOwn.status, 200);
    assert.deepEqual((await outsiderOwn.json()).map(row => row.id), [privateLeadB.id]);

    const outsiderList = await call("/partner/google/connections", {
      headers: { cookie: outsiderCookie },
    });
    assert.deepEqual((await outsiderList.json()).connections, []);
    assert.equal((await call("/partner/google/connect/start?partnerId=" + firstWorkspace,
      { headers: { cookie: outsiderCookie }, redirect: "manual" })).status, 403);
    assert.equal((await call("/partner/google/connections/" + firstWorkspace, {
      method: "DELETE", headers: { cookie: outsiderCookie, origin },
    })).status, 403);
    assert.equal(await partnerDb.partnerGoogleConnection.count(), 1);

    assert.equal((await call("/partner/google/connections/" + firstWorkspace, {
      method: "DELETE", headers: { cookie: partnerCookie },
    })).status, 403, "Disconnect requires CSRF origin");
    assert.equal((await call("/partner/google/connections/" + firstWorkspace, {
      method: "DELETE", headers: { cookie: partnerCookie, origin },
    })).status, 200);
    assert.equal((await call("/partner/google/connections/" + firstWorkspace, {
      method: "DELETE", headers: { cookie: partnerCookie, origin },
    })).status, 200, "Disconnect is idempotent");
    assert.equal(await partnerDb.partnerGoogleConnection.count(), 0);

    // Continue from a third simulated proxy client for revocation and review.
    smokeClientIp = "198.51.100.12";
    // Concurrent membership revocation cannot commit between authorization
    // and an authorized candidate write. The row lock must be held until the
    // candidate transaction commits, not just until the membership SELECT.
    const { lockActiveWorkspaceMembership } = await import("../server/workspace-access.js");
    let releaseMemberLock;
    let lockAcquired;
    const memberLockAcquired = new Promise(resolve => { lockAcquired = resolve; });
    const memberLockRelease = new Promise(resolve => { releaseMemberLock = resolve; });
    const lockedWrite = partnerDb.$transaction(async tx => {
      assert.equal(await lockActiveWorkspaceMembership(tx, {
        userId: member.id, workspaceId: secondWorkspace,
      }), true);
      lockAcquired();
      await memberLockRelease;
      await tx.candidate.create({ data: {
        workspaceId: secondWorkspace,
        name: "Authorized before revoke", category: "COACHING",
        sourceUrl: "https://example.org/pre-revoke",
      } });
    });
    await memberLockAcquired;
    let revokeCommitted = false;
    const revocation = partnerDb.partnerMembership.update({
      where: { partnerId_userId: { partnerId: secondWorkspace, userId: member.id } },
      data: { revokedAt: new Date() },
    }).then(result => { revokeCommitted = true; return result; });
    try {
      // A real concurrent UPDATE must block on the membership row lock.
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(revokeCommitted, false,
        "Revocation must wait for the in-flight authorized write transaction");
    } finally {
      releaseMemberLock();
    }
    await lockedWrite;
    await revocation;
    assert.equal(revokeCommitted, true);
    assert.equal((await submitCandidate({ cookie: partnerCookie },
      "?workspaceId=" + secondWorkspace, {
        ...manualCandidate, email: "post-revoke@example.org",
      })).status, 403,
      "New candidate writes are forbidden after revocation commits");

    // Membership may be revoked while consent is underway; a valid signed
    // Google response cannot recreate its authorization after revocation.
    const revokedFlow = await beginGoogleConnection(firstWorkspace, partnerCookie);
    // A prior Forms/Sheets refresh grant must be erased when workspace access
    // is revoked; the Google account's unrelated Gmail consent stays separate.
    const { encryptKey } = await import("../server/security.js");
    await partnerDb.partnerGoogleConnection.create({ data: {
      partnerId: firstWorkspace, userId: member.id, googleSub: "google-test-sub",
      encryptedRefreshToken: encryptKey("ci-only-refresh-token", env.AI_ENCRYPTION_KEY),
      scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    } });
    const revokeUrl = "/admin/partners/memberships/" + firstMembership.id;
    assert.equal((await call(revokeUrl, { method: "DELETE",
      headers: { origin, cookie: partnerCookie } })).status, 401,
      "Google partner may never revoke workspace membership");
    assert.equal((await call(revokeUrl, { method: "DELETE",
      headers: { cookie } })).status, 403, "Admin revoke requires same-origin CSRF");
    assert.equal((await call("/admin/partners/memberships/invalid", {
      method: "DELETE", headers: protectedHeaders })).status, 400);
    assert.equal((await call("/admin/partners/memberships/" + "c" + "x".repeat(24), {
      method: "DELETE", headers: protectedHeaders })).status, 404);
    const firstRevoke = await call(revokeUrl, {
      method: "DELETE", headers: protectedHeaders,
    });
    assert.equal(firstRevoke.status, 200);
    assert.deepEqual(await firstRevoke.json(), {
      revoked: true, workspaceId: firstWorkspace, changed: true,
    });
    const secondRevoke = await call(revokeUrl, {
      method: "DELETE", headers: protectedHeaders,
    });
    assert.equal(secondRevoke.status, 200);
    assert.deepEqual(await secondRevoke.json(), {
      revoked: true, workspaceId: firstWorkspace, changed: false,
    });
    assert.equal(await partnerDb.partnerMembership.count({
      where: { id: firstMembership.id, revokedAt: { not: null } },
    }), 1, "Revocation preserves the membership row and audit history");
    assert.equal(await partnerDb.auditEvent.count({
      where: { action: "partner.membership.revoked", entityId: firstMembership.id },
    }), 1, "Idempotent revocation emits exactly one audit event");
    assert.equal(await partnerDb.partnerGoogleConnection.count({
      where: { partnerId: firstWorkspace, userId: member.id },
    }), 0, "Revocation must delete workspace-scoped Google refresh credentials");
    assert.equal((await completeGoogleConnection(revokedFlow)).status, 403);
    assert.equal(await partnerDb.partnerGoogleConnection.count(), 0);

    assert.equal((await call(inviteUrl, { method: "POST",
      headers: { origin, cookie: partnerCookie, "content-type": "application/json" },
      body: JSON.stringify({ partnerName: "Attack", email: "new@example.org" }) })).status, 401);
    await partnerDb.partnerMembership.updateMany({ where: { userId: member.id },
      data: { revokedAt: new Date() } });
    assert.equal((await call(inviteUrl, { method: "POST", headers: protectedHeaders,
      body: JSON.stringify({ partnerId: secondWorkspace, email: "partner@example.org" }) })).status, 409,
      "A revoked membership must not reactivate through retry");
    const revoked = await call("/partner/session", { headers: { cookie: partnerCookie } });
    assert.deepEqual(await revoked.json(), { authenticated: false },
      "Membership revocation must take effect immediately");
  } finally {
    await partnerDb.$disconnect();
  }

  // The evidence ledger appends only once and never upgrades qualification.
  const evidenceDb = new (await import("@prisma/client")).PrismaClient();
  try {
    const lead = await evidenceDb.candidate.findFirst({
      where: { discoveryKey: "c".repeat(64) },
    });
    assert.ok(lead);
    const url = "/candidates/" + lead.id + "/evidence";
    assert.equal((await call(url)).status, 401);
    assert.equal((await call(url, { method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ kind: "PROFILE", sourceUrl: "https://example.org/author" }) })).status, 403);
    const item = { kind: "ARTICLE", sourceUrl: "https://example.org/posts/1?utm_source=test",
      note: "Article source only; not proof of services" };
    const created = await call(url, { method: "POST", headers: protectedHeaders,
      body: JSON.stringify(item) });
    assert.equal(created.status, 201, "Evidence creation: " + await created.text());
    const replay = await call(url, { method: "POST", headers: protectedHeaders,
      body: JSON.stringify({ ...item, sourceUrl: "https://example.org/posts/1" }) });
    assert.equal(replay.status, 200);
    const saved = await call(url, { headers: { cookie } });
    assert.equal(saved.status, 200);
    const evidences = await saved.json();
    assert.equal(evidences.length, 1);
    assert.equal(evidences[0].kind, "ARTICLE");
    assert.equal(evidences[0].normalizedUrl, "https://example.org/posts/1");
    assert.equal(await evidenceDb.auditEvent.count({
      where: { entityId: lead.id, action: "candidate.evidence.added" },
    }), 1);
    const suggestions = await call("/candidates/" + lead.id + "/possible-duplicates", { headers: { cookie } });
    assert.equal(suggestions.status, 200);
    assert.deepEqual((await suggestions.json()).suggestions, []);
    // Historical candidate profiles may be HTTP under the existing contract.
    // Identity hints must not reject an otherwise readable legacy record.
    const legacyHttp = await evidenceDb.candidate.create({ data: {
      name: "Legacy HTTP Profile", category: "COACHING",
      sourceUrl: "https://example.org/articles/legacy",
      expertProfileUrl: "http://legacy.example.org/expert",
      onlineEnglish: false,
    } });
    const legacyHints = await call("/candidates/" + legacyHttp.id + "/possible-duplicates",
      { headers: { cookie } });
    assert.equal(legacyHints.status, 200, "Legacy HTTP profile must not yield 400");
    assert.deepEqual((await legacyHints.json()).suggestions, []);
    const untouched = await evidenceDb.candidate.findUnique({ where: { id: lead.id } });
    assert.equal(untouched.profileReviewed, true);
    assert.equal(untouched.sourceUrl, "https://example.org/articles/automation");
    assert.equal((await call("/candidates/" + lead.id + "/draft", {
      method: "POST", headers: protectedHeaders,
    })).status, 409);
  } finally {
    await evidenceDb.$disconnect();
  }

  const saving = await call("/ai-settings", { method: "PUT", headers: protectedHeaders,
    body: JSON.stringify({ provider: "gemini", model: "gemini-2.5-flash", apiKey: "test-only-provider-secret-value" }),
  });
  assert.equal(saving.status, 200);
  const config = await call("/ai-settings", { headers: { cookie } });
  assert.equal(config.status, 200);
  const configText = await config.text();
  assert.equal(configText.includes("test-only-provider-secret-value"), false);
  assert.equal(JSON.parse(configText).keyConfigured, true);

  const candidate = await call("/candidates", { method: "POST", headers: protectedHeaders,
    body: JSON.stringify({ name: "Sample Candidate", category: "COACHING",
      sourceUrl: "https://example.org/sample", onlineEnglish: true, region: "US" }),
  });
  assert.equal(candidate.status, 201, "Candidate write: " + await candidate.text());
  const list = await call("/candidates", { headers: { cookie } });
  assert.equal(list.status, 200);
  const listed = await list.json();
  const manual = listed.find(item => item.name === "Sample Candidate");
  assert.ok(manual);
  assert.equal(manual.qualification.score, null);
  assert.equal(manual.qualification.stage, "QUALIFIED");
  assert.equal(manual.outreach.canDraft, false);
  assert.equal((await call("/candidates/" + manual.id + "/draft", {
    method: "POST", headers: protectedHeaders,
  })).status, 409, "Legacy manual record must meet contact review gate");
  assert.equal((await call("/send", { method: "POST", headers: protectedHeaders })).status, 404);
  console.log("HTTP integration smoke passed: auth, CSRF, encrypted key storage, candidates, no sending");
} finally {
  server.kill("SIGTERM");
  await new Promise(resolve => {
    if (server.exitCode !== null) return resolve();
    server.once("exit", resolve);
    setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 3000).unref();
  });
}
