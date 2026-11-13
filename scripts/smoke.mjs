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
};
const server = spawn(process.execPath, ["server/index.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
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
    assert.equal(entries.find(item => item.id === discovered.id).name, "TimidRobot");
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
    const firstWorkspace = (await invite.json()).partnerId;
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
    assert.equal((await call("/candidates", { headers: { cookie: partnerCookie } })).status, 401);
    assert.equal((await call("/ai-settings", { headers: { cookie: partnerCookie } })).status, 401);
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
  assert.ok((await list.json()).some(item => item.name === "Sample Candidate"));
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
