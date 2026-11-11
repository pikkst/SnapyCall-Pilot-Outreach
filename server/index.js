import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { normalizeCandidate, outreachDecision, scoreCandidate, EXPERT_CATEGORIES } from "../src/domain.js";
import { parseApprovedSources, discoverFeed, discoveryKeyFor } from "./discovery.js";
import { requireRuntimeConfig, encryptKey, decryptKey, keyFingerprint, makeSession, verifySession, validWriteOrigin } from "./security.js";
import { aiConfigSchema, generateDraft } from "./ai.js";
import { bootstrapAdmin, verifyAdmin } from "./admin-auth.js";

const env = requireRuntimeConfig();
const prisma = new PrismaClient({ log: ["error"] });
const approvedDiscoveryFeeds = parseApprovedSources(process.env.DISCOVERY_FEED_URLS);
const app = express();
app.disable("x-powered-by");
if (process.env.TRUST_PROXY) {
  const hops = Number(process.env.TRUST_PROXY);
  if (!Number.isInteger(hops) || hops < 0 || hops > 3) throw new Error("Invalid TRUST_PROXY");
  app.set("trust proxy", hops);
}
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "32kb" }));
app.use(cookieParser());
app.use("/api", rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-7", legacyHeaders: false }));

function sessionCookie(res, value, maxAge) {
  res.cookie("pilot_session", value, {
    httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production",
    path: "/", maxAge,
  });
}

function authenticated(req, res, next) {
  if (!verifySession(req.cookies?.pilot_session, env.SESSION_SIGNING_KEY)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return next();
}

function requireOrigin(req, res, next) {
  if (!validWriteOrigin(req)) return res.status(403).json({ error: "Invalid origin" });
  return next();
}

function safe(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
}

async function audit(action, entityId, metadata) {
  await prisma.auditEvent.create({
    data: { actorId: "admin", action, entityId, metadata },
  });
}

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
app.get("/api/ready", safe(async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ready" });
  } catch {
    res.status(503).json({ status: "unavailable" });
  }
}));

const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 8, standardHeaders: "draft-7", legacyHeaders: false });
app.post("/api/session", requireOrigin, loginLimiter, safe(async (req, res) => {
  const input = z.object({ email: z.string().email(), password: z.string().min(1).max(256) }).parse(req.body);
  if (!await verifyAdmin(input.email, input.password, prisma)) return res.status(401).json({ error: "Invalid credentials" });
  sessionCookie(res, makeSession(env.SESSION_SIGNING_KEY), 8 * 60 * 60 * 1000);
  return res.json({ authenticated: true });
}));
app.get("/api/session", (req, res) => res.json({ authenticated: verifySession(req.cookies?.pilot_session, env.SESSION_SIGNING_KEY) }));
app.delete("/api/session", requireOrigin, (_req, res) => {
  sessionCookie(res, "", 0);
  res.json({ authenticated: false });
});

const write = [authenticated, requireOrigin];
// Free discovery: explicit RSS/Atom sources, no paid people-search API.
// Each scan is a bounded, admin-triggered read. Imports require separate review.
app.get("/api/discovery/sources", authenticated, (_req, res) => {
  res.json({ feeds: approvedDiscoveryFeeds, providerCost: 0, requiresReview: true });
});
const scanLimiter = rateLimit({ windowMs: 60_000, limit: 2, standardHeaders: "draft-7", legacyHeaders: false });
app.post("/api/discovery/scan", authenticated, requireOrigin, scanLimiter, safe(async (req, res) => {
  const input = z.object({ feedUrl: z.string().url().max(1200) }).strict().parse(req.body);
  if (!approvedDiscoveryFeeds.includes(input.feedUrl)) return res.status(403).json({ error: "Feed is not approved" });
  const entries = await discoverFeed({ url: input.feedUrl, approvedSources: approvedDiscoveryFeeds });
  res.json({ entries, providerCost: 0, requiresReview: true });
}));
app.post("/api/discovery/import", authenticated, requireOrigin, safe(async (req, res) => {
  const schema = z.object({
    feedUrl: z.string().url().max(1200),
    name: z.string().trim().min(2).max(160),
    sourceUrl: z.string().url().max(2048),
    category: z.enum(Object.keys(EXPERT_CATEGORIES)),
  }).strict();
  const input = schema.parse(req.body);
  if (!approvedDiscoveryFeeds.includes(input.feedUrl)) return res.status(403).json({ error: "Feed is not approved" });
  const candidate = normalizeCandidate({
    name: input.name, sourceUrl: input.sourceUrl, category: input.category, onlineEnglish: false,
  });
  const discoveryKey = discoveryKeyFor(input.feedUrl, candidate.name);
  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
      const existing = await tx.candidate.findUnique({ where: { discoveryKey } });
      if (existing) return { id: existing.id, created: false };
      const created = await tx.candidate.create({
        data: {
          discoveryKey, name: candidate.name, category: candidate.category,
          sourceUrl: candidate.sourceUrl, onlineEnglish: false,
          contactReviewed: false, status: "REVIEW_PENDING",
        },
      });
      await tx.auditEvent.create({ data: {
        actorId: "admin", action: "discovery.candidate.imported", entityId: created.id,
        metadata: { feedUrl: input.feedUrl, sourceUrl: candidate.sourceUrl },
      } });
      return { id: created.id, created: true };
    });
  } catch (error) {
    // Concurrent review clicks can race the initial existence check.
    // The unique DB constraint determines the winner; the loser reads it.
    if (error?.code !== "P2002") throw error;
    const winner = await prisma.candidate.findUnique({ where: { discoveryKey } });
    if (!winner) throw error;
    result = { id: winner.id, created: false };
  }
  res.status(result.created ? 201 : 200).json(result);
}));
app.get("/api/candidates", authenticated, safe(async (_req, res) => {
  const items = await prisma.candidate.findMany({ orderBy: { createdAt: "desc" }, take: 500 });
  res.json(items.map((item) => ({ ...item, score: scoreCandidate(item) })));
}));
app.post("/api/candidates", ...write, safe(async (req, res) => {
  const candidate = normalizeCandidate(req.body);
  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.candidate.create({
      data: {
      kind: "EXPERT", name: candidate.name, category: candidate.category,
      email: candidate.email, emailNormalized: candidate.email,
      region: candidate.region, onlineEnglish: candidate.onlineEnglish,
      sourceUrl: candidate.sourceUrl, legalBasis: candidate.legalBasis,
      contactReviewed: candidate.contactReviewed, suppressed: candidate.suppressed,
      },
    });
    await tx.auditEvent.create({ data: {
      actorId: "admin", action: "candidate.created", entityId: created.id,
      metadata: { sourceUrl: created.sourceUrl },
    } });
    return created;
  });
  res.status(201).json({ id: row.id });
}));

app.get("/api/ai-settings", authenticated, safe(async (_req, res) => {
  const setting = await prisma.aiSetting.findUnique({ where: { ownerId: "admin" } });
  res.json(setting ? {
    provider: setting.provider, model: setting.model,
    keyConfigured: true, fingerprint: setting.keyFingerprint,
  } : { provider: "gemini", model: "gemini-2.5-flash", keyConfigured: false });
}));
app.put("/api/ai-settings", ...write, safe(async (req, res) => {
  const input = aiConfigSchema.parse(req.body);
  const existing = await prisma.aiSetting.findUnique({ where: { ownerId: "admin" } });
  if (!input.apiKey && !existing) return res.status(400).json({ error: "API key required" });
  if (!input.apiKey && existing.provider !== input.provider) {
    return res.status(400).json({ error: "New provider requires an API key" });
  }
  const encryptedApiKey = input.apiKey
    ? encryptKey(input.apiKey, env.AI_ENCRYPTION_KEY)
    : existing.encryptedApiKey;
  const fingerprint = input.apiKey ? keyFingerprint(input.apiKey) : existing.keyFingerprint;
  await prisma.$transaction(async (tx) => {
    await tx.aiSetting.upsert({
      where: { ownerId: "admin" },
      create: {
        ownerId: "admin", provider: input.provider, model: input.model,
        encryptedApiKey, keyFingerprint: fingerprint,
      },
      update: { provider: input.provider, model: input.model, encryptedApiKey, keyFingerprint: fingerprint },
    });
    await tx.auditEvent.create({ data: {
      actorId: "admin", action: "ai.settings.updated", entityId: "admin",
      metadata: { provider: input.provider, model: input.model },
    } });
  });
  res.json({ saved: true, keyConfigured: true, fingerprint });
}));
app.delete("/api/ai-settings", ...write, safe(async (_req, res) => {
  await prisma.$transaction(async (tx) => {
    await tx.aiSetting.deleteMany({ where: { ownerId: "admin" } });
    await tx.auditEvent.create({ data: {
      actorId: "admin", action: "ai.settings.deleted", entityId: "admin",
    } });
  });
  res.json({ removed: true });
}));

const draftLimiter = rateLimit({ windowMs: 60_000, limit: 6, standardHeaders: "draft-7", legacyHeaders: false });
app.post("/api/candidates/:id/draft", ...write, draftLimiter, safe(async (req, res) => {
  const candidate = await prisma.candidate.findUnique({ where: { id: req.params.id } });
  if (!candidate) return res.status(404).json({ error: "Candidate not found" });
  const eligibility = outreachDecision(candidate);
  if (!eligibility.canDraft || candidate.suppressed) return res.status(409).json({ error: "Candidate ineligible for drafting" });
  const setting = await prisma.aiSetting.findUnique({ where: { ownerId: "admin" } });
  if (!setting) return res.status(409).json({ error: "Configure an AI provider first" });
  const apiKey = decryptKey(setting.encryptedApiKey, env.AI_ENCRYPTION_KEY);
  const draft = await generateDraft({ provider: setting.provider, model: setting.model, apiKey, candidate });
  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.outreachDraft.create({
      data: { candidateId: candidate.id, subject: draft.subject, body: draft.body, provider: setting.provider, model: setting.model },
    });
    await tx.auditEvent.create({ data: {
      actorId: "admin", action: "draft.generated", entityId: created.id,
      metadata: { candidateId: candidate.id, provider: setting.provider, model: setting.model },
    } });
    return created;
  });
  res.status(201).json({ id: row.id, ...draft });
}));
app.get("/api/drafts", authenticated, safe(async (_req, res) => {
  const drafts = await prisma.outreachDraft.findMany({
    take: 200, orderBy: { createdAt: "desc" },
    include: { candidate: { select: { id: true, name: true } } },
  });
  res.json(drafts);
}));

// No send endpoint exists. Drafts may only be copied/reviewed manually.
app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, _req, res, _next) => {
  if (err instanceof z.ZodError || err instanceof TypeError) return res.status(400).json({ error: "Invalid input" });
  if (err?.code === "P2002") return res.status(409).json({ error: "Duplicate contact" });
  console.error("[server] Request failed:", err?.code ?? err?.name ?? "Error");
  res.status(500).json({ error: "Request failed" });
});

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "../dist");
app.use(express.static(dist));
app.get("/", (_req, res) => res.sendFile(path.join(dist, "index.html")));

async function start() {
  try {
    await prisma.$connect();
    await prisma.$queryRaw`SELECT 1`;
    const result = await bootstrapAdmin(prisma, env);
    if (result.created) console.log("[auth] Admin credential initialized in database; remove ADMIN_PASSWORD from Render environment.");
  } catch {
    await prisma.$disconnect();
    throw new Error("Database or admin bootstrap unavailable; refusing to start");
  }
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
  const server = app.listen(port, "0.0.0.0", () => console.log("Pilot admin listening on port " + port));
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
start().catch(() => {
  console.error("Startup failed; check server configuration and database access");
  process.exitCode = 1;
});
