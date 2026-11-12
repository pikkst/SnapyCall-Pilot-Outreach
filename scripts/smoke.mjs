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
