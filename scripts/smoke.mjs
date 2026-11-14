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
  RESEND_API_KEY: "ci-only-resend-token",
  PARTNER_INVITE_FROM: "SnapyCall <invites@example.test>",
  PILOT_GOOGLE_MOCK: "integration-only",
};
const server = spawn(process.execPath,
  ["--import", "./scripts/google-data-smoke-mock.mjs", "server/index.js"],
  { env, stdio: ["ignore", "pipe", "pipe"] });
let logs = "";
for (const stream of [server.stdout, server.stderr]) {
  stream.on("data", chunk => { logs += chunk.toString(); });
}

async function call(path, init = {}) {
  return fetch(origin + "/api" + path, init);
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

    // Membership may be revoked while consent is underway; a valid signed
    // Google response cannot recreate its authorization after revocation.
    const revokedFlow = await beginGoogleConnection(firstWorkspace, partnerCookie);
    await partnerDb.partnerMembership.update({
      where: { partnerId_userId: { partnerId: firstWorkspace, userId: member.id } },
      data: { revokedAt: new Date() },
    });
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
