import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { normalizeCandidate, outreachDecision, scoreCandidate, qualificationDecision, EXPERT_CATEGORIES } from "../src/domain.js";
import { parseApprovedSources, discoverFeed, normalizeFeedAuthor, DiscoverySourceError } from "./discovery.js";
import { signScanEntry, verifyScanEntry } from "./discovery-proof.js";
import { canonicalEvidenceUrl, EVIDENCE_KINDS, sameIdentityHints } from "../src/evidence.js";
import { requireRuntimeConfig, encryptKey, decryptKey, keyFingerprint, makeSession, verifySession, validWriteOrigin } from "./security.js";
import { sessionIdentityState, canUseAdminSession } from "./session-isolation.js";
import { aiConfigSchema, generateDraft } from "./ai.js";
import { researchCandidates, researchInput, ResearchProviderHttpError, ResearchProviderExecutionError, publicResearchProviderFailure } from "./ai-research.js";
import { GEMINI3_TEST_MODEL, GEMINI3_TEST_RESERVE_CENTS, GEMINI3_TEST_ACTION,
  GEMINI3_TEST_CONFIRMATION, summarizeGemini3TestResponse } from "./gemini3-one-shot.js";
import { planResearchCampaign } from "./research-campaign-planner.js";
import { summarizeCampaignProgress } from "./research-campaign-observations.js";
import { runOneCampaignTask, ResearchWorkerPreflightError } from "./research-campaign-worker.js";
import { approvePersonSourceResearch } from "./research-person-source-approval.js";
import { approveCampaignRun, stopApprovedCampaignRun,
  publicRunStatus, ApprovedRunBlocked }
  from "./research-campaign-run-approval.js";
import { startApprovedCampaignWorker } from "./research-approved-runner.js";
import { normalizeManualResearchSources, enqueueManualResearchSources } from "./research-manual-sources.js";
import { inspectCampaignObservationEmail } from "./research-observation-email.js";
import { summarizeQualifiedEmailEvidence } from "./research-qualified-evidence.js";
import { planPersonSourceResolution, publicPersonSourcePlan } from "./research-person-source-plan.js";
import { approveEmailTriage, stopEmailTriage, emailTriageSummary,
  emailTriageSourceReadiness, startEmailTriageWorker }
  from "./research-email-triage-worker.js";
import { approveGroundingResolution, stopGroundingResolution,
  groundingResolutionSummary, startGroundingResolutionWorker }
  from "./research-grounding-worker.js";
import { acceptReviewedCampaignContact } from "./research-observation-contact-intake.js";
import { runBoundedCampaignSlice } from "./research-campaign-slice.js";
import { skipPausedResearchTask } from "./research-campaign-reconciliation.js";
import { inspectResearchPreview } from "./research-contact-enrichment.js";
import { inspectAndStoreDirectEmailObservation } from "./candidate-direct-email-evidence.js";
import { reviewCandidateDirectEmailEvidence, directEmailReviewSnapshot } from "./candidate-direct-email-review.js";
import { projectCandidateContactReadiness } from "./candidate-contact-readiness.js";
import { inspectEmailDomain, onboardingEmailEligibility } from "./email-deliverability.js";
import { inspectAndPersistCandidateDns, visibleCandidateDnsSnapshot } from "./candidate-email-dns.js";
import { normalizeManualLeadSeed } from "./manual-lead-seed.js";
import { normalizeDiscoveryLeadSeed } from "./discovery-lead-seed.js";
import { partnerSelfProfileInput, publicPartnerSelfProfile } from "./partner-self-profile.js";
import { assertWebResearchModel } from "./research-provider-adapters.js";
import {
  reserveResearchAttempt, ResearchQuotaExceeded, lockedResearchPreferences,
  validateResearchPreferences, RESEARCH_DAILY_USER_WORKSPACE_LIMIT,
  reserveResearchLease, releaseResearchLease, ResearchConcurrencyExceeded,
  ResearchPacingRequired,
} from "./research-quota.js";
import { validateMonthlyBudgetCents, reserveOwnerSpend, settleOwnerSpend,
  ResearchBudgetExceeded, readOwnerBudgetSnapshot,
  readResearchReconciliationOverview } from "./research-budget.js";
import { evaluateResearchReconciliationAlert } from "./research-reconciliation-alert.js";
import { requireResearchPriceEnvelope, ResearchPricingUnavailable,
  researchPriceReadiness, calculateVerifiedSpendCents } from "./research-price-policy.js";
import { bootstrapAdmin, verifyAdmin } from "./admin-auth.js";
import { googleOAuthConfig, createGoogleFlow, verifyGoogleFlow, exchangeGoogleCode,
  verifyGoogleIdToken, createPartnerSession, verifyPartnerSession } from "./google-auth.js";
import { googleDataConfig, googleGmailConfig, createGoogleDataFlow, verifyGoogleDataFlow,
  exchangeGoogleDataCode } from "./google-data-auth.js";
import { requireWorkspaceMembership, lockActiveWorkspaceMembership } from "./workspace-access.js";
import { deliverPartnerInvitation, publicInvitationStatus,
  invitationEmailConfig, resetInvitationAttempt } from "./partner-invitations.js";

const env = requireRuntimeConfig();
const google = googleOAuthConfig(env);
const googleData = googleDataConfig(env);
const googleGmail = env.GMAIL_OAUTH_ENABLED === "true" ? googleGmailConfig(env) : null;
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
  const state = sessionIdentityState(req.cookies, env.SESSION_SIGNING_KEY);
  if (state.conflict) return res.status(409).json({
    code: "SESSION_IDENTITY_CONFLICT",
    error: "Both admin and partner sessions are active. Sign out of both before continuing.",
  });
  if (!canUseAdminSession(req.cookies, env.SESSION_SIGNING_KEY)) {
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
  // A successful administrator login replaces any existing Google partner
  // session in this browser; it must never inherit another tenant's identity.
  partnerCookie(res, "", 0);
  sessionCookie(res, makeSession(env.SESSION_SIGNING_KEY), 8 * 60 * 60 * 1000);
  return res.json({ authenticated: true });
}));
app.get("/api/session", (req, res) => {
  res.set("Cache-Control", "no-store");
  const state = sessionIdentityState(req.cookies, env.SESSION_SIGNING_KEY);
  return res.json({ authenticated: state.admin && !state.conflict, conflict: state.conflict });
});
app.delete("/api/session", requireOrigin, (_req, res) => {
  sessionCookie(res, "", 0);
  res.json({ authenticated: false });
});

// Google login is invite-only. Existing admin credentials retain exclusive
// access to legacy candidate/draft/settings routes until tenant scoping ships.
function partnerCookie(res, value, maxAge) {
  res.cookie("pilot_partner_session", value, {
    httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production",
    path: "/", maxAge,
  });
}
async function partnerIdentity(req) {
  const userId = verifyPartnerSession(req.cookies?.pilot_partner_session, env.SESSION_SIGNING_KEY);
  if (!userId) return null;
  const user = await prisma.partnerUser.findUnique({
    where: { id: userId },
    include: { memberships: { where: { revokedAt: null },
      include: { partner: { select: { id: true, name: true } } } } },
  });
  if (!user?.googleSub || !user.memberships.length) return null;
  return user;
}
// This is a separate consent from Google identity login. A strict partner
// session is required to start; the signed browser-bound flow cookie is used
// on Google's cross-site callback because SameSite=Strict session cookies
// are intentionally unavailable during that redirect.
const dataFlowPath = "/api/partner/google/connect";
function clearDataFlow(res) {
  res.clearCookie("pilot_google_data_flow", {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
    path: dataFlowPath,
  });
}
app.get("/api/partner/google/connections", safe(async (req, res) => {
  const user = await partnerIdentity(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const ids = user.memberships.map(m => m.partnerId);
  const connections = await prisma.partnerGoogleConnection.findMany({
    where: { userId: user.id, partnerId: { in: ids } },
    select: { partnerId: true, scope: true, updatedAt: true },
  });
  return res.json({ connections, available: Boolean(googleData) });
}));
app.get("/api/partner/google/connect/start", loginLimiter, safe(async (req, res) => {
  const user = await partnerIdentity(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  if (!googleData) return res.status(503).json({ error: "Google data access not configured" });
  const partnerId = req.query.partnerId;
  if (typeof partnerId !== "string" || !user.memberships.some(m => m.partnerId === partnerId)) {
    return res.status(403).json({ error: "Workspace membership required" });
  }
  const flow = createGoogleDataFlow(googleData, env.SESSION_SIGNING_KEY,
    { userId: user.id, partnerId });
  res.cookie("pilot_google_data_flow", flow.cookie, {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
    path: dataFlowPath, maxAge: 10 * 60_000,
  });
  return res.redirect(302, flow.url);
}));
app.get("/api/partner/google/connect/callback", safe(async (req, res) => {
  const cookie = req.cookies?.pilot_google_data_flow;
  clearDataFlow(res);
  if (!googleData || typeof req.query.code !== "string" ||
      typeof req.query.state !== "string" || req.query.error) {
    return res.status(400).send("Google data access was not completed");
  }
  const flow = verifyGoogleDataFlow(cookie, req.query.state, env.SESSION_SIGNING_KEY);
  if (!flow) return res.status(403).send("Google data consent expired or invalid");
  // Membership may have been revoked while the user was on Google consent.
  const user = await prisma.partnerUser.findUnique({
    where: { id: flow.userId },
    include: { memberships: { where: { partnerId: flow.partnerId, revokedAt: null } } },
  });
  if (!user?.googleSub || !user.memberships.length) {
    return res.status(403).send("Workspace access is no longer available");
  }
  let tokens, identity;
  try {
    tokens = await exchangeGoogleDataCode(req.query.code, flow, googleData);
    identity = await verifyGoogleIdToken(tokens.id_token, googleData, flow.nonce);
  } catch {
    return res.status(403).send("Google did not grant the required permissions");
  }
  if (identity.googleSub !== user.googleSub || identity.emailNormalized !== user.emailNormalized) {
    return res.status(403).send("Connect with the invited Google account");
  }
  const encrypted = encryptKey(tokens.refresh_token, env.AI_ENCRYPTION_KEY);
  const saved = await prisma.$transaction(async tx => {
    const active = await tx.partnerMembership.findUnique({
      where: { partnerId_userId: { partnerId: flow.partnerId, userId: flow.userId } },
    });
    if (!active || active.revokedAt) return false;
    await tx.partnerGoogleConnection.upsert({
      where: { partnerId_userId: { partnerId: flow.partnerId, userId: flow.userId } },
      create: { partnerId: flow.partnerId, userId: flow.userId, googleSub: identity.googleSub,
        encryptedRefreshToken: encrypted, scope: tokens.scope },
      update: { googleSub: identity.googleSub, encryptedRefreshToken: encrypted, scope: tokens.scope },
    });
    await tx.auditEvent.create({ data: { actorId: flow.userId,
      action: "partner.google_data.connected", entityId: flow.partnerId } });
    return true;
  });
  if (!saved) return res.status(403).send("Workspace access was revoked");
  return res.redirect(303, "/");
}));
app.delete("/api/partner/google/connections/:partnerId", requireOrigin, safe(async (req, res) => {
  const user = await partnerIdentity(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  if (!user.memberships.some(m => m.partnerId === req.params.partnerId)) {
    return res.status(403).json({ error: "Workspace membership required" });
  }
  const removed = await prisma.$transaction(async tx => {
    const result = await tx.partnerGoogleConnection.deleteMany({
      where: { partnerId: req.params.partnerId, userId: user.id },
    });
    if (result.count) await tx.auditEvent.create({ data: { actorId: user.id,
      action: "partner.google_data.disconnected", entityId: req.params.partnerId } });
    return result.count;
  });
  return res.json({ disconnected: true, changed: removed > 0 });
}));
// Gmail send consent is user-owned, independent from Google identity login
// and Forms/Sheets data read consent. There is intentionally NO send endpoint.
const gmailFlowPath = "/api/partner/google/gmail";
function clearGmailFlow(res) {
  res.clearCookie("pilot_google_gmail_flow", {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
    path: gmailFlowPath,
  });
}
app.get("/api/partner/google/gmail", safe(async (req, res) => {
  const user = await partnerIdentity(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const grant = await prisma.partnerGmailConnection.findUnique({
    where: { userId: user.id }, select: { scope: true, updatedAt: true },
  });
  return res.json({
    available: Boolean(googleGmail),
    connected: Boolean(grant),
    email: user.emailNormalized,
    ...(grant ? { scope: grant.scope, updatedAt: grant.updatedAt } : {}),
    sendingEnabled: false,
  });
}));
// Consent starts must not consume the sign-in brute-force budget.
// Keep independent protection against repeated Gmail authorization prompts.
const gmailConsentLimiter = rateLimit({
  windowMs: 15 * 60_000, limit: 8, standardHeaders: "draft-7", legacyHeaders: false,
});
app.get("/api/partner/google/gmail/start", gmailConsentLimiter, safe(async (req, res) => {
  const user = await partnerIdentity(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  if (!googleGmail) return res.status(503).json({ error: "Gmail consent is not enabled" });
  const workspaceId = req.query.workspaceId;
  if (typeof workspaceId !== "string" ||
      !user.memberships.some(m => m.partnerId === workspaceId)) {
    return res.status(403).json({ error: "Active workspace membership required" });
  }
  const flow = createGoogleDataFlow(googleGmail, env.SESSION_SIGNING_KEY,
    { userId: user.id, partnerId: workspaceId, kind: "gmail" });
  res.cookie("pilot_google_gmail_flow", flow.cookie, {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
    path: gmailFlowPath, maxAge: 10 * 60_000,
  });
  return res.redirect(302, flow.url);
}));
app.get("/api/partner/google/gmail/callback", safe(async (req, res) => {
  const cookie = req.cookies?.pilot_google_gmail_flow;
  clearGmailFlow(res);
  if (!googleGmail || typeof req.query.code !== "string" ||
      typeof req.query.state !== "string" || req.query.error) {
    return res.status(400).send("Gmail consent was not completed");
  }
  const flow = verifyGoogleDataFlow(cookie, req.query.state,
    env.SESSION_SIGNING_KEY, Date.now(), "gmail");
  if (!flow) return res.status(403).send("Gmail consent expired or invalid");
  const user = await prisma.partnerUser.findUnique({
    where: { id: flow.userId },
    include: { memberships: { where: { partnerId: flow.partnerId, revokedAt: null } } },
  });
  if (!user?.googleSub || !user.memberships.length) {
    return res.status(403).send("Workspace access was revoked");
  }
  let tokens, identity;
  try {
    tokens = await exchangeGoogleDataCode(req.query.code, flow, googleGmail);
    identity = await verifyGoogleIdToken(tokens.id_token, googleGmail, flow.nonce);
  } catch {
    return res.status(403).send("Gmail send permission was not granted");
  }
  if (identity.googleSub !== user.googleSub || identity.emailNormalized !== user.emailNormalized) {
    return res.status(403).send("Connect Gmail with the invited Google account");
  }
  const encrypted = encryptKey(tokens.refresh_token, env.AI_ENCRYPTION_KEY);
  const saved = await prisma.$transaction(async tx => {
    // Re-check membership on the transaction boundary after the OAuth exchange.
    const active = await tx.partnerMembership.findUnique({
      where: { partnerId_userId: { partnerId: flow.partnerId, userId: flow.userId } },
    });
    if (!active || active.revokedAt) return false;
    await tx.partnerGmailConnection.upsert({
      where: { userId: flow.userId },
      create: { userId: flow.userId, googleSub: identity.googleSub,
        encryptedRefreshToken: encrypted, scope: tokens.scope },
      update: { googleSub: identity.googleSub,
        encryptedRefreshToken: encrypted, scope: tokens.scope },
    });
    await tx.auditEvent.create({ data: {
      actorId: flow.userId, action: "partner.gmail_send.connected",
      entityId: flow.partnerId,
    } });
    return true;
  });
  if (!saved) return res.status(403).send("Workspace access was revoked");
  return res.redirect(303, "/");
}));
app.delete("/api/partner/google/gmail", requireOrigin, safe(async (req, res) => {
  const user = await partnerIdentity(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const removed = await prisma.$transaction(async tx => {
    const result = await tx.partnerGmailConnection.deleteMany({
      where: { userId: user.id },
    });
    if (result.count) await tx.auditEvent.create({ data: {
      actorId: user.id, action: "partner.gmail_send.disconnected",
      entityId: user.id,
    } });
    return result.count;
  });
  return res.json({ disconnected: true, changed: removed > 0 });
}));

app.get("/api/partner/session", safe(async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (sessionIdentityState(req.cookies, env.SESSION_SIGNING_KEY).conflict) {
    return res.json({ authenticated: false, conflict: true });
  }
  const user = await partnerIdentity(req);
  if (!user) return res.json({ authenticated: false });
  return res.json({
    authenticated: true, userId: user.id, displayName: user.displayName,
    partners: user.memberships.map(m => ({ id: m.partner.id, name: m.partner.name, role: m.role })),
  });
}));
// Profile belongs to the signed-in Google user, never a workspace or
// arbitrary userId selected by the browser. This route does not grant send
// permission, edit Google identity email, or change workspace membership.
app.get("/api/partner/profile", safe(async (req, res) => {
  const user = await partnerIdentity(req);
  if (!user) return res.status(401).json({ error: "Partner session required" });
  return res.json(publicPartnerSelfProfile(user));
}));
app.put("/api/partner/profile", requireOrigin, safe(async (req, res) => {
  const user = await partnerIdentity(req);
  if (!user) return res.status(401).json({ error: "Partner session required" });
  const parsed = partnerSelfProfileInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({
    error: "Invalid profile details",
    fields: parsed.error.issues.map(issue => issue.path.join(".")),
  });
  const saved = await prisma.partnerUser.update({
    where: { id: user.id },
    data: parsed.data,
  });
  return res.json(publicPartnerSelfProfile(saved));
}));
app.delete("/api/partner/session", requireOrigin, (_req, res) => {
  partnerCookie(res, "", 0);
  return res.json({ authenticated: false });
});
// Creating an invitation grants NO access until the exact Google account
// proves its verified email and permanently binds the Google subject.
app.post("/api/admin/partners/invite", ...[authenticated, requireOrigin], safe(async (req, res) => {
  const input = z.object({
    partnerName: z.string().trim().min(2).max(120).optional(),
    partnerId: z.string().cuid().optional(),
    email: z.string().email().max(254),
  }).strict().refine(value => Boolean(value.partnerName) !== Boolean(value.partnerId), {
    message: "Supply exactly one of partnerName or partnerId",
  }).parse(req.body);
  const emailNormalized = input.email.trim().toLowerCase();
  const result = await prisma.$transaction(async tx => {
    // An existing workspace is selected by its opaque ID, never by a
    // non-unique display name. The admin session is required by this route.
    let user = await tx.partnerUser.findUnique({ where: { emailNormalized } });
    if (user && !input.partnerId) {
      return { status: 409, error: "Existing identity requires a workspace ID" };
    }
    const partner = input.partnerId
      ? await tx.partner.findUnique({ where: { id: input.partnerId } })
      : await tx.partner.create({ data: { name: input.partnerName } });
    if (!partner) return { status: 404, error: "Partner workspace not found" };
    if (!user) user = await tx.partnerUser.create({ data: { emailNormalized } });
    const membership = await tx.partnerMembership.findUnique({
      where: { partnerId_userId: { partnerId: partner.id, userId: user.id } },
    });
    if (membership?.revokedAt) {
      return { status: 409, error: "Revoked membership requires explicit administrator reactivation" };
    }
    if (membership) return { status: 200, partnerId: partner.id, membershipId: membership.id,
      invited: true, existing: true };
    const created = await tx.partnerMembership.create({
      data: { userId: user.id, partnerId: partner.id },
    });
    await tx.auditEvent.create({ data: { actorId: "admin",
      action: "partner.invited", entityId: partner.id } });
    return { status: 201, partnerId: partner.id, membershipId: created.id, invited: true };
  }).catch(error => {
    if (error?.code === "P2002") return { status: 409, error: "Concurrent invitation conflict; retry with the workspace ID" };
    throw error;
  });
  if (result.membershipId && result.status === 201) {
    const delivery = await deliverPartnerInvitation(prisma, result.membershipId);
    return res.status(201).json({ ...result, emailStatus: delivery.status });
  }
  return res.status(result.status).json(result);
}));
app.get("/api/admin/partners/invitations", authenticated, safe(async (_req, res) => {
  const rows = await prisma.partnerMembership.findMany({
    take: 500, orderBy: { createdAt: "desc" },
    include: { partner: { select: { id: true, name: true } },
      user: { select: { emailNormalized: true } } },
  });
  return res.json({ emailConfigured: Boolean(invitationEmailConfig()),
    invitations: rows.map(m => ({
      id: m.id, workspaceId: m.partnerId, workspace: m.partner.name,
      email: m.user.emailNormalized, status: publicInvitationStatus(m),
      sentAt: m.inviteSentAt, acceptedAt: m.acceptedAt,
      leaseUntil: m.inviteLeaseUntil,
      errorCode: m.inviteErrorCode, attempt: m.inviteAttempt,
    })) });
}));
// Revocation is a soft-delete of workspace access. Keep membership history and
// existing candidate ownership intact. Only the separate admin session may act.
app.delete("/api/admin/partners/memberships/:id", authenticated, requireOrigin,
  safe(async (req, res) => {
    const parsed = z.string().cuid().safeParse(req.params.id);
    if (!parsed.success) return res.status(400).json({ error: "Invalid membership ID" });
    const result = await prisma.$transaction(async tx => {
      const member = await tx.partnerMembership.findUnique({
        where: { id: parsed.data }, select: { id: true, partnerId: true, userId: true, revokedAt: true },
      });
      if (!member) return null;
      if (member.revokedAt) return { workspaceId: member.partnerId, changed: false };
      // CAS ensures concurrent administrative requests generate exactly one
      // revocation event, and serializes with membership-locked writes.
      const changed = await tx.partnerMembership.updateMany({
        where: { id: member.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (changed.count) {
        // The workspace-specific refresh token must not outlive access.
        // User-owned Gmail consent is a separate grant and is not touched.
        await tx.partnerGoogleConnection.deleteMany({
          where: { partnerId: member.partnerId, userId: member.userId },
        });
        await tx.auditEvent.create({
          data: { actorId: "admin", action: "partner.membership.revoked",
            entityId: member.id,
            metadata: { workspaceId: member.partnerId, userId: member.userId } },
        });
      }
      return { workspaceId: member.partnerId, changed: changed.count === 1 };
    });
    if (!result) return res.status(404).json({ error: "Membership not found" });
    return res.json({ revoked: true, ...result });
  }));
app.post("/api/admin/partners/invitations/:id/resend", authenticated, requireOrigin,
  safe(async (req, res) => {
    const input = z.object({ newAttempt: z.boolean().optional() }).strict().parse(req.body ?? {});
    const member = await prisma.partnerMembership.findUnique({ where: { id: req.params.id } });
    if (!member) return res.status(404).json({ error: "Invitation not found" });
    if (member.revokedAt || member.acceptedAt) return res.status(409).json({ error: "Invitation no longer pending" });
    if (member.inviteStatus === "SENDING" &&
        (!member.inviteLeaseUntil || member.inviteLeaseUntil.getTime() > Date.now())) {
      return res.status(409).json({ error: "Invitation send is in progress; verify delivery before retrying" });
    }
    if (member.inviteStatus === "SENT" && !input.newAttempt) {
      return res.status(409).json({ error: "Invitation already sent. Confirm a new attempt explicitly." });
    }
    if (input.newAttempt) {
      // Compare the exact attempt and lease observed above. An expired lease
      // may have been reclaimed by another request since the initial read.
      const reset = await resetInvitationAttempt(prisma, member);
      if (!reset) return res.status(409).json({ error: "Invitation state changed; refresh and retry" });
    }
    const delivery = await deliverPartnerInvitation(prisma, member.id);
    return res.json({ emailStatus: delivery.status });
  }));
app.get("/api/admin/partners", authenticated, safe(async (_req, res) => {
  const partners = await prisma.partner.findMany({
    select: { id: true, name: true }, orderBy: { createdAt: "desc" }, take: 500,
  });
  return res.json({ partners });
}));
app.get("/api/auth/google/start", loginLimiter, (req, res) => {
  if (!google) return res.status(503).json({ error: "Google login not configured" });
  const flow = createGoogleFlow(google, env.SESSION_SIGNING_KEY);
  res.cookie("pilot_google_flow", flow.cookie, {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
    path: "/api/auth/google", maxAge: 10 * 60_000,
  });
  return res.redirect(302, flow.url);
});
app.get("/api/auth/google/callback", safe(async (req, res) => {
  // Always clear one-time state before evaluating the authorization response.
  const cookie = req.cookies?.pilot_google_flow;
  res.clearCookie("pilot_google_flow", {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
    path: "/api/auth/google",
  });
  if (!google || typeof req.query.state !== "string" ||
      typeof req.query.code !== "string" || req.query.error) {
    return res.status(400).send("Google login could not be completed");
  }
  const flow = verifyGoogleFlow(cookie, req.query.state, env.SESSION_SIGNING_KEY);
  if (!flow) return res.status(403).send("Google login expired or invalid");
  let identity;
  try {
    const idToken = await exchangeGoogleCode(req.query.code, flow, google);
    identity = await verifyGoogleIdToken(idToken, google, flow.nonce);
  } catch {
    return res.status(403).send("Google authentication failed");
  }
  const user = await prisma.partnerUser.findUnique({
    where: { emailNormalized: identity.emailNormalized },
    include: { memberships: { where: { revokedAt: null }, select: { id: true } } },
  });
  if (!user?.memberships.length || (user.googleSub && user.googleSub !== identity.googleSub)) {
    return res.status(403).send("This Google account has not been invited");
  }
  if (!user.googleSub) {
    // A previous successful binding cannot be silently replaced by a later
    // login or a concurrent attempt with a different Google account.
    const bound = await prisma.$transaction(async tx => {
      const updated = await tx.partnerUser.updateMany({
        where: { id: user.id, googleSub: null },
        data: { googleSub: identity.googleSub, displayName: identity.displayName },
      });
      if (updated.count !== 1) return false;
      await tx.auditEvent.create({ data: {
        actorId: user.id, action: "partner.google.bound", entityId: user.id,
      } });
      return true;
    }).catch(() => false);
    if (!bound) return res.status(403).send("Google identity binding failed");
  }
  // An invitation is accepted only after the invited Google identity has
  // successfully completed the real OIDC callback.
  await prisma.partnerMembership.updateMany({
    where: { userId: user.id, revokedAt: null, acceptedAt: null },
    data: { acceptedAt: new Date() },
  });
  // Only after verified OIDC identity + active invitation, replace any
  // existing administrator cookie. Failed OAuth attempts do not mutate it.
  sessionCookie(res, "", 0);
  partnerCookie(res, createPartnerSession(user.id, env.SESSION_SIGNING_KEY), 8 * 60 * 60_000);
  return res.redirect(303, "/");
}));
// Shared read routes start tenant-aware without granting partner write access.
// Admin-only legacy rows remain visible only to the original admin session.
async function candidateReadScope(req, res, next) {
  try {
    const admin = verifySession(req.cookies?.pilot_session, env.SESSION_SIGNING_KEY);
    const user = await partnerIdentity(req);
    if (admin && user) return res.status(409).json({ error: "Multiple active identities; sign out of one" });
    if (!admin && !user) return res.status(401).json({ error: "Unauthorized" });
    if (admin) {
      if (req.query.workspaceId !== undefined) return res.status(403).json({ error: "Admin legacy data has no partner workspace" });
      req.candidateScope = null;
    } else {
      const membership = await requireWorkspaceMembership(prisma, {
        userId: user.id, workspaceId: req.query.workspaceId,
      });
      if (!membership) return res.status(403).json({ error: "Active workspace membership required" });
      req.candidateScope = membership.workspaceId;
    }
    return next();
  } catch (error) {
    return next(error);
  }
}
// A user's AI credential belongs to their authenticated identity, not a
// shared workspace. Admin legacy credentials remain in their own record.
// Dual admin+partner cookies are ambiguous: fail closed rather than silently
// using the privileged admin key for the Google-authenticated user.
async function aiOwnerAuthenticated(req, res, next) {
  try {
    const admin = verifySession(req.cookies?.pilot_session, env.SESSION_SIGNING_KEY);
    const partner = await partnerIdentity(req);
    if (admin && partner) return res.status(409).json({
      error: "Two active identities. Sign out of one account before changing AI settings",
    });
    if (!admin && !partner) return res.status(401).json({ error: "Unauthorized" });
    req.aiOwnerId = admin ? "admin" : partner.id;
    return next();
  } catch (error) {
    return next(error);
  }
}
const aiWrite = [aiOwnerAuthenticated, requireOrigin];
const write = [authenticated, requireOrigin];
// Free discovery: explicit RSS/Atom sources, no paid people-search API.
// Each scan is a bounded, admin-triggered read. Imports require separate review.
app.get("/api/discovery/sources", authenticated, (_req, res) => {
  res.json({ feeds: approvedDiscoveryFeeds, providerCost: 0, requiresReview: true });
});
// Paid research preview is opt-in, authenticated and read-only. It never
// modifies candidate, evidence or draft state and cannot send outreach.
// Separate short-window abuse protection from configurable daily research
// quota. A JSON 429 preserves the frontend API error contract and does not
// consume an AI provider call or a monetary reservation.
const researchLimiter = rateLimit({
  windowMs: 60_000, limit: 2,
  standardHeaders: "draft-7", legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({
    code: "RESEARCH_MINUTE_RATE_LIMIT",
    error: "Research allows at most 2 requests per 60 seconds. Wait a minute before retrying. The daily attempt setting does not change this rate limit.",
  }),
});
// Campaign execution has its own abuse window. The original research limiter
// also protects profile and mailbox inspections; unrelated manual reads must
// not consume the campaign execution budget. Quota/spend checks remain
// authoritative inside the database transaction for every paid call.
const campaignExecutionLimiter = rateLimit({
  windowMs: 60_000, limit: 10,
  standardHeaders: "draft-7", legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({
    code: "CAMPAIGN_EXECUTION_RATE_LIMIT",
    error: "Campaign execution is temporarily rate limited. No provider call was started. Check progress before trying again.",
  }),
});
// Preferences can be set only by the Google partner who owns the BYOK key.
// An admin's separate AI setting never grants tenant research authorization.
// Personal BYOK budget is denominated in USD, the providers' billing
// currency. It is NOT yet wired to provider calls: missing price bounds must
// keep AI web research disabled instead of silently promising enforcement.
// Admin-only global anomaly counts. Never expose owner/workspace identifiers,
// individual ledger records or mutation paths to the browser.
app.get("/api/admin/research-reconciliation", authenticated, safe(async (_req, res) => {
  res.set("Cache-Control", "no-store");
  const overview = await readResearchReconciliationOverview(prisma);
  return res.json({ ...overview,
    alert: evaluateResearchReconciliationAlert(overview),
  });
}));
async function ownerResearchBudgetReadiness(ownerId) {
  const [snapshot, setting] = await Promise.all([
    readOwnerBudgetSnapshot(prisma, ownerId),
    prisma.aiSetting.findUnique({
      where: { ownerId }, select: { provider: true, model: true },
    }),
  ]);
  // Project the exact saved provider/model through the same reviewed tariff
  // gate as claimResearchTask. An app budget or an external Google spend cap
  // cannot authorize a tariff-less Google Search call.
  return { ...snapshot, ...researchPriceReadiness({
    setting, enabled: env.AI_WEB_RESEARCH_ENABLED === "true",
    remainingCents: snapshot.ledger.availableCents,
  }) };
}
app.get("/api/research-budget", aiOwnerAuthenticated, safe(async (req, res) => {
  const identity = await partnerIdentity(req);
  if (!identity || identity.id !== req.aiOwnerId) {
    return res.status(403).json({ error: "Google partner session required" });
  }
  return res.json(await ownerResearchBudgetReadiness(identity.id));
}));
app.put("/api/research-budget", aiOwnerAuthenticated, requireOrigin, safe(async (req, res) => {
  const identity = await partnerIdentity(req);
  if (!identity || identity.id !== req.aiOwnerId) {
    return res.status(403).json({ error: "Google partner session required" });
  }
  const input = z.object({ monthlyLimitCents: z.number().int().min(100).max(100_000) })
    .strict().parse(req.body);
  validateMonthlyBudgetCents(input.monthlyLimitCents);
  const key = await prisma.aiSetting.findUnique({
    where: { ownerId: identity.id }, select: { id: true },
  });
  if (!key) return res.status(409).json({ error: "Configure your personal API key first" });
  await prisma.$transaction(async tx => {
    // This row is the spending lock shared with every reservation. Upserts and
    // their PostgreSQL row lock serialize limit changes against all workspaces.
    await tx.researchOwnerBudget.upsert({
      where: { ownerId: identity.id },
      create: { ownerId: identity.id, monthlyLimitCents: input.monthlyLimitCents },
      update: { monthlyLimitCents: input.monthlyLimitCents },
    });
    await tx.auditEvent.create({ data: {
      actorId: identity.id, action: "ai.research-budget.updated",
      entityId: identity.id, metadata: { currency: "USD", ...input },
    } });
  });
  return res.json(await ownerResearchBudgetReadiness(identity.id));
}));
app.get("/api/research-limits", aiOwnerAuthenticated, safe(async (req, res) => {
  const identity = await partnerIdentity(req);
  if (!identity || identity.id !== req.aiOwnerId) {
    return res.status(403).json({ error: "Google partner session required" });
  }
  const stored = await prisma.researchUserLimits.findUnique({
    where: { ownerId: identity.id },
    select: { dailyLimit: true, maxCandidates: true, maxConcurrent: true },
  });
  return res.json(stored ?? { dailyLimit: RESEARCH_DAILY_USER_WORKSPACE_LIMIT, maxCandidates: 10, maxConcurrent: 1 });
}));
app.put("/api/research-limits", aiOwnerAuthenticated, requireOrigin, safe(async (req, res) => {
  const identity = await partnerIdentity(req);
  if (!identity || identity.id !== req.aiOwnerId) {
    return res.status(403).json({ error: "Google partner session required" });
  }
  const input = z.object({
    dailyLimit: z.number().int().min(1).max(100),
    maxCandidates: z.number().int().min(1).max(20),
    maxConcurrent: z.number().int().min(1).max(3),
  }).strict().parse(req.body);
  validateResearchPreferences(input);
  const hasKey = await prisma.aiSetting.findUnique({ where: { ownerId: identity.id },
    select: { id: true } });
  if (!hasKey) return res.status(409).json({ error: "Configure a personal API key first" });
  const saved = await prisma.$transaction(async tx => {
    const limits = await tx.researchUserLimits.upsert({
      where: { ownerId: identity.id },
      create: { ownerId: identity.id, ...input },
      update: input,
      select: { dailyLimit: true, maxCandidates: true, maxConcurrent: true },
    });
    await tx.auditEvent.create({ data: {
      actorId: identity.id, action: "ai.research-limits.updated",
      entityId: identity.id, metadata: { ...limits },
    } });
    return limits;
  });
  return res.json(saved);
}));
// Read-only recovery path for the one-shot diagnostic. A browser refresh,
// disconnect or Render restart never gives permission to issue another call.
app.get("/api/discovery/gemini3-one-shot", candidateReadScope,
  safe(async (req, res) => {
    if (req.candidateScope === null) return res.status(403).json({
      code: "WORKSPACE_REQUIRED", error: "Active workspace required",
    });
    const identity = await partnerIdentity(req);
    if (!identity || !await requireWorkspaceMembership(prisma, {
      workspaceId: req.candidateScope, userId: identity.id,
    })) return res.status(403).json({ error: "Workspace membership required" });
    if (identity.id !== env.AI_GEMINI3_SINGLE_TEST_OWNER_ID) {
      return res.status(403).json({ code: "TEST_OWNER_MISMATCH" });
    }
    const [started, finished] = await Promise.all([
      prisma.auditEvent.findFirst({
        where: { actorId: identity.id, action: GEMINI3_TEST_ACTION },
        orderBy: { createdAt: "desc" }, select: { createdAt: true },
      }),
      prisma.auditEvent.findFirst({
        where: { actorId: identity.id, action: "ai.gemini3-one-shot.finished" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true, metadata: true },
      }),
    ]);
    if (!started) return res.json({ status: "NOT_RUN" });
    if (!finished) return res.json({ status: "PENDING_RECONCILIATION",
      error: "The single paid request may already have been dispatched. No replay." });
    const m = finished.metadata;
    return res.json({ status: "FINISHED", code: m?.outcomeCode ?? "UNKNOWN",
      diagnostic: {
        model: GEMINI3_TEST_MODEL, finished: m?.finished === true,
        finishReason: typeof m?.finishReason === "string" ? m.finishReason : null,
        inputTokens: m?.inputTokens ?? null, outputTokens: m?.outputTokens ?? null,
        thinkingTokens: m?.thinkingTokens ?? null, searchQueries: m?.searchQueries ?? null,
        groundingChunks: m?.groundingChunks ?? null, estimateUsd: m?.estimateUsd ?? null,
        providerInvoiceConfirmed: false, currency: "USD",
      },
      appReservationCents: GEMINI3_TEST_RESERVE_CENTS,
      appReservationIsNotProviderInvoice: true,
      noContactsImported: true, noEmailSent: true,
    });
  }));
// Explicit one-use diagnostic exception. This does NOT add Gemini 3 to
// approvedResearchPrices or authorize normal campaign research. Google
// Search query count is controlled by Google, not by our budget reservation.
app.post("/api/discovery/gemini3-one-shot", candidateReadScope, requireOrigin,
  researchLimiter, safe(async (req, res) => {
    if (env.AI_GEMINI3_SINGLE_TEST_ENABLED !== "true" ||
        env.AI_WEB_RESEARCH_ENABLED !== "true") {
      return res.status(503).json({ code: "GEMINI3_TEST_DISABLED",
        error: "The one-use Gemini 3 experiment is not enabled" });
    }
    if (req.candidateScope === null) return res.status(403).json({
      code: "WORKSPACE_REQUIRED", error: "Active partner workspace required",
    });
    if (!/^c[a-z0-9]{10,40}$/.test(env.AI_GEMINI3_SINGLE_TEST_OWNER_ID ?? "")) {
      return res.status(503).json({ code: "TEST_OWNER_UNCONFIGURED",
        error: "Single-test owner authorization is not configured" });
    }
    const identity = await partnerIdentity(req);
    if (!identity) return res.status(401).json({ error: "Unauthorized" });
    if (identity.id !== env.AI_GEMINI3_SINGLE_TEST_OWNER_ID) {
      return res.status(403).json({ code: "GEMINI3_TEST_OWNER_MISMATCH",
        error: "This one-time experiment is not authorized for this account" });
    }
    const input = z.object({
      query: z.string().trim().min(12).max(350),
      confirmation: z.literal(GEMINI3_TEST_CONFIRMATION),
    }).strict().parse(req.body);
    const setting = await prisma.aiSetting.findUnique({
      where: { ownerId: identity.id },
    });
    if (!setting || setting.provider !== "gemini" ||
        setting.model !== GEMINI3_TEST_MODEL) return res.status(409).json({
      code: "GEMINI3_MODEL_REQUIRED",
      error: "Save Gemini 3 Flash Preview in AI Settings before the single test",
    });
    let apiKey;
    try { apiKey = decryptKey(setting.encryptedApiKey, env.AI_ENCRYPTION_KEY); }
    catch { return res.status(409).json({ code: "RESEARCH_KEY_UNAVAILABLE",
      error: "Stored Gemini API key unavailable; re-save in AI Settings" }); }
    if (typeof apiKey !== "string" || apiKey.length < 8) {
      return res.status(409).json({ code: "RESEARCH_KEY_UNAVAILABLE",
        error: "Personal Gemini API key is required" });
    }

    let reservation;
    try {
      reservation = await prisma.$transaction(async tx => {
        if (!await lockActiveWorkspaceMembership(tx, {
          workspaceId: req.candidateScope, userId: identity.id,
        })) return null;
        const prefs = await lockedResearchPreferences(tx, identity.id);
        const leaseId = await reserveResearchLease(tx, {
          workspaceId: req.candidateScope, userId: identity.id,
          maxConcurrent: prefs.maxConcurrent,
        });
        const reservationId = randomUUID();
        // The budget row lock serializes the consumed marker across every
        // workspace, browser tab and Render worker for this owner.
        await reserveOwnerSpend(tx, {
          ownerId: identity.id, workspaceId: req.candidateScope,
          reservationId, worstCaseCents: GEMINI3_TEST_RESERVE_CENTS,
        });
        const used = await tx.auditEvent.count({
          where: { actorId: identity.id, action: GEMINI3_TEST_ACTION },
        });
        if (used !== 0) {
          // Throwing rolls back the provisional lease and money reservation.
          throw Object.assign(new Error("Gemini 3 one-shot already consumed"), {
            code: "GEMINI3_TEST_ALREADY_USED",
          });
        }
        const quota = await reserveResearchAttempt(tx, {
          workspaceId: req.candidateScope, userId: identity.id,
          dailyLimit: prefs.dailyLimit,
        });
        await tx.auditEvent.create({ data: {
          actorId: identity.id, action: GEMINI3_TEST_ACTION,
          entityId: reservationId,
          metadata: { workspaceId: req.candidateScope,
            model: GEMINI3_TEST_MODEL, providerCallsAuthorized: 1,
            conservativeAppReservationCents: GEMINI3_TEST_RESERVE_CENTS,
            externalSpendHardCapped: false, noReplay: true },
        } });
        return { reservationId, leaseId, quota };
      });
    } catch (error) {
      if (error?.code === "GEMINI3_TEST_ALREADY_USED") {
        return res.status(409).json({ code: "GEMINI3_TEST_ALREADY_USED",
          error: "The one-shot experiment is already consumed. No replay allowed." });
      }
      if (error instanceof ResearchPacingRequired) {
        res.set("Retry-After", String(error.retryAfterSeconds));
        return res.status(429).json({
          code: "RESEARCH_PACING_WAIT", retryAfterSeconds: error.retryAfterSeconds,
          error: "No provider call was started; the pacing gate is active",
        });
      }
      if (error instanceof ResearchBudgetExceeded) return res.status(429).json({
        code: "RESEARCH_BUDGET_EXCEEDED",
        error: "Insufficient app budget for the one-shot diagnostic reservation",
      });
      if (error instanceof ResearchQuotaExceeded ||
          error instanceof ResearchConcurrencyExceeded) return res.status(429).json({
        code: "RESEARCH_LIMIT_REACHED",
        error: "Daily research quota or active concurrency limit reached",
      });
      throw error;
    }
    if (!reservation) return res.status(403).json({ error: "Workspace revoked" });
    let settled = false;
    let summary = null;
    let completed = false;
    let outcomeCode = "UNCONFIRMED_UPSTREAM_OUTCOME";
    try {
      // A revoked membership must never use a still-valid BYOK key.
      if (!await requireWorkspaceMembership(prisma, {
        workspaceId: req.candidateScope, userId: identity.id,
      })) {
        outcomeCode = "WORKSPACE_REVOKED";
        return res.status(403).json({ code: outcomeCode,
          error: "Workspace access changed; diagnostic was not dispatched" });
      }
      // One trusted provider invocation. No retry/repair, no campaign tasks,
      // no contact import, no email inspection and no message sending.
      try {
        const result = await researchCandidates({
          query: input.query, limit: 10, provider: "gemini",
          model: GEMINI3_TEST_MODEL, apiKey,
        }, { post: async (url, headers, body, signal) => {
          const response = await fetch(url, {
            method: "POST", headers: {
              "content-type": "application/json", ...headers,
            }, body: JSON.stringify(body), signal,
          });
          if (!response.ok) throw new ResearchProviderHttpError(response.status);
          const raw = await response.json();
          summary = summarizeGemini3TestResponse(raw);
          return raw;
        } });
        completed = true;
        outcomeCode = "VALIDATED";
        return res.json({ status: "COMPLETED", code: outcomeCode,
          diagnostic: summary, sourcedCandidates: result.candidates.length,
          noContactsImported: true, noEmailSent: true,
          appReservationCents: GEMINI3_TEST_RESERVE_CENTS,
          appReservationIsNotProviderInvoice: true });
      } catch (error) {
        outcomeCode = error?.code === "NO_VERIFIABLE_GROUNDING" ?
          "NO_VERIFIABLE_GROUNDING" :
          error?.code === "NO_USABLE_STRUCTURED_OUTPUT" ?
          "NO_USABLE_STRUCTURED_OUTPUT" :
          error instanceof ResearchProviderHttpError ?
          "PROVIDER_HTTP_REJECTED" : "UNCONFIRMED_UPSTREAM_OUTCOME";
        return res.status(200).json({
          status: outcomeCode === "UNCONFIRMED_UPSTREAM_OUTCOME" ||
            outcomeCode === "PROVIDER_HTTP_REJECTED" ?
            "BILLING_UNCERTAIN" : "COMPLETED_WITH_NO_ACCEPTED_EVIDENCE",
          code: outcomeCode, diagnostic: summary,
          noContactsImported: true, noEmailSent: true,
          providerInvoiceConfirmed: false,
          appReservationCents: GEMINI3_TEST_RESERVE_CENTS,
          appReservationIsNotProviderInvoice: true,
        });
      }
    } finally {
      try {
        await prisma.$transaction(async tx => {
          await settleOwnerSpend(tx, {
            ownerId: identity.id, workspaceId: req.candidateScope,
            reservationId: reservation.reservationId,
            actualCents: !completed && outcomeCode === "WORKSPACE_REVOKED"
              ? 0 : null,
          });
          await tx.auditEvent.create({ data: {
            actorId: identity.id, action: "ai.gemini3-one-shot.finished",
            entityId: reservation.reservationId,
            metadata: { workspaceId: req.candidateScope, outcomeCode,
              ...(summary ?? {}), conservativeAppReservationCents:
              GEMINI3_TEST_RESERVE_CENTS, providerInvoiceConfirmed: false },
          } });
        });
        settled = true;
      } finally {
        if (!settled) console.warn("[gemini3-test] Spend needs reconciliation");
        await releaseResearchLease(prisma, reservation.leaseId,
          req.candidateScope, identity.id);
      }
    }
  }));
app.post("/api/discovery/ai-research", candidateReadScope, requireOrigin, researchLimiter, safe(async (req, res) => {
  // Explicit staged activation; no accidental spend or data disclosure at deploy.
  if (env.AI_WEB_RESEARCH_ENABLED !== "true") return res.status(503).json({
    error: "AI web research has not been enabled for this environment",
  });
  // Partner-only until admin and partner research contracts are unified.
  if (req.candidateScope === null) return res.status(403).json({ error: "Select a Google partner workspace" });
  const identity = await partnerIdentity(req);
  if (!identity) return res.status(401).json({ error: "Unauthorized" });
  const input = researchInput.parse(req.body);
  const setting = await prisma.aiSetting.findUnique({ where: { ownerId: identity.id } });
  if (!setting || !["anthropic", "openai", "gemini"].includes(setting.provider)) {
    return res.status(409).json({ error: "Configure a supported personal AI provider and API key" });
  }
  // Model/tool incompatibility must fail before any reservation or paid call.
  if (setting.provider !== "anthropic") {
    try { assertWebResearchModel(setting.provider, setting.model); }
    catch { return res.status(409).json({ error: "Selected model does not support configured web search" }); }
  }
  // A feature flag, daily quota and saved monthly preference must never
  // authorize provider charges without an approved cost ceiling. This
  // preflight intentionally rejects every model until the owner-wide
  // reserve/settle integration and verified prices land in #44.
  let priceEnvelope;
  try {
    priceEnvelope = requireResearchPriceEnvelope({ provider: setting.provider, model: setting.model });
  } catch (error) {
    if (error instanceof ResearchPricingUnavailable) {
      return res.status(503).json({
        code: "RESEARCH_PRICING_UNAVAILABLE",
        error: "Paid research cannot run until pricing and monetary controls are approved",
      });
    }
    throw error;
  }
  // Validate stored BYOK material before reserving any billable amount.
  // A local decryption/configuration failure cannot have reached the provider.
  let apiKey;
  try {
    apiKey = decryptKey(setting.encryptedApiKey, env.AI_ENCRYPTION_KEY);
  } catch {
    return res.status(409).json({
      code: "RESEARCH_KEY_UNAVAILABLE",
      error: "Your saved personal API key cannot be used. Re-save it under My AI provider before searching.",
    });
  }
  let quota;
  try {
    quota = await prisma.$transaction(async tx => {
      // Lock membership until the durable quota reservation commits.
      // A concurrent member revocation cannot leave an authorized reservation.
      const membership = await lockActiveWorkspaceMembership(tx, {
        workspaceId: req.candidateScope, userId: identity.id,
      });
      if (!membership) return null;
      const preferences = await lockedResearchPreferences(tx, identity.id);
      // Reject oversized requests before reserving a paid search.
      if (input.limit > preferences.maxCandidates) return { limitExceeded: true };
      // Reserve the concurrency slot and daily budget atomically.
      // Any failure rolls back both; provider calls occur after commit.
      const leaseId = await reserveResearchLease(tx, {
        workspaceId: req.candidateScope, userId: identity.id,
        maxConcurrent: preferences.maxConcurrent,
      });
      // Reserve the owner-wide currency budget in the same transaction as
      // the workspace lease and daily quota. A failed monetary reservation
      // rolls back the lease and never consumes a daily attempt.
      const reservationId = randomUUID();
      await reserveOwnerSpend(tx, {
        ownerId: identity.id, workspaceId: req.candidateScope, reservationId,
        worstCaseCents: priceEnvelope.worstCaseCents,
      });
      const quota = await reserveResearchAttempt(tx, {
        workspaceId: req.candidateScope, userId: identity.id,
        dailyLimit: preferences.dailyLimit,
      });
      await tx.auditEvent.create({ data: {
        actorId: identity.id, action: "ai.research-spend.reserved",
        entityId: reservationId,
        metadata: { workspaceId: req.candidateScope, provider: setting.provider,
          model: setting.model, priceVersion: priceEnvelope.priceVersion,
          worstCaseCents: priceEnvelope.worstCaseCents, currency: "USD" },
      } });
      return { ...quota, preferences, leaseId, reservationId };
    });
  } catch (error) {
    if (error instanceof ResearchQuotaExceeded) {
      return res.status(429).json({ error: "Daily research quota reached",
        code: "RESEARCH_QUOTA_EXCEEDED" });
    }
    if (error instanceof ResearchConcurrencyExceeded) {
      return res.status(429).json({ error: "Active research concurrency limit reached",
        code: "RESEARCH_CONCURRENCY_EXCEEDED" });
    }
    if (error instanceof ResearchPacingRequired) {
      res.set("Retry-After", String(error.retryAfterSeconds));
      return res.status(429).json({ code: "RESEARCH_PACING_WAIT",
        retryAfterSeconds: error.retryAfterSeconds,
        error: "The next AI request is safely scheduled; no paid call was started." });
    }
    if (error instanceof ResearchBudgetExceeded) {
      return res.status(429).json({ error: "Monthly research budget unavailable or exhausted",
        code: "RESEARCH_BUDGET_EXCEEDED" });
    }
    throw error;
  }
  if (!quota) return res.status(403).json({ error: "Workspace membership revoked" });
  if (quota.limitExceeded) return res.status(400).json({
    error: "Requested candidate count exceeds your configured limit",
    code: "RESEARCH_RESULT_LIMIT_EXCEEDED",
  });
  // Membership can be revoked after the quota transaction commits. Recheck
  // immediately before making a chargeable external provider request.
  let settled = false;
  const settle = async actualCents => {
    await prisma.$transaction(async tx => {
      await settleOwnerSpend(tx, {
        ownerId: identity.id, workspaceId: req.candidateScope,
        reservationId: quota.reservationId, actualCents,
      });
      await tx.auditEvent.create({ data: {
        actorId: identity.id, action: "ai.research-spend.settled",
        entityId: quota.reservationId,
        metadata: { workspaceId: req.candidateScope, currency: "USD",
          chargedCents: actualCents ?? priceEnvelope.worstCaseCents,
          conservative: actualCents === null },
      } });
    });
    settled = true;
  };
  try {
    if (!await requireWorkspaceMembership(prisma, {
      workspaceId: req.candidateScope, userId: identity.id,
    })) {
      // No chargeable call has occurred: release the money, not the attempt.
      await settle(0);
      return res.status(403).json({ error: "Workspace membership revoked" });
    }
    const output = await researchCandidates({
      ...input, provider: setting.provider, model: setting.model, apiKey,
    });
    // Only server-side provider usage with a reviewed exact-model tariff can
    // reduce the reservation. Missing or unsupported usage keeps the entire
    // worst-case amount charged; browser numbers are never accepted.
    const verifiedCents = calculateVerifiedSpendCents(priceEnvelope, output.usage);
    await settle(verifiedCents);
    // Public-page inspection is optional and distinct from billable provider
    // research. It cannot import candidates or authorize email sending.
    let inspection = null;
    if (env.AI_PUBLIC_CONTACT_INSPECTION_ENABLED === "true") {
      if (!await requireWorkspaceMembership(prisma, {
        workspaceId: req.candidateScope, userId: identity.id,
      })) {
        return res.status(403).json({ error: "Workspace membership revoked" });
      }
      inspection = await inspectResearchPreview(output);
    }
    return res.json({ ...output, ...(inspection ?? {}),
      workspaceId: req.candidateScope,
      quota: { dayUtc: quota.dayUtc, remaining: quota.remaining } });
  } catch (error) {
    if (error instanceof ResearchProviderHttpError) {
      // The user gets a stable category. Logs contain no key, body or URL.
      console.warn("[research] Provider rejected request; HTTP status:", error.status);
      return res.status(502).json(publicResearchProviderFailure(error.status));
    }
    if (error instanceof ResearchProviderExecutionError) {
      console.warn("[research] Provider transport or response validation failed");
      return res.status(502).json({
        code: "RESEARCH_PROVIDER_RESULT_UNUSABLE",
        error: "AI provider request or result validation failed. Check your provider connection and available credits before retrying.",
      });
    }
    throw error;
  } finally {
    if (!settled) {
      try {
        // The provider may have billed before a timeout or network failure.
        // If DB settlement fails, preserve the reservation for reconciliation.
        await settle(null);
      } catch {
        console.error("[research] Monetary settlement failed; funds remain reserved");
      }
    }
    try {
      await releaseResearchLease(prisma, quota.leaseId, req.candidateScope, identity.id);
    } catch {
      console.warn("[research] Failed to release search lease; expiry will recover");
    }
  }
}));
const scanLimiter = rateLimit({ windowMs: 60_000, limit: 2, standardHeaders: "draft-7", legacyHeaders: false });
app.post("/api/discovery/scan", authenticated, requireOrigin, scanLimiter, safe(async (req, res) => {
  const input = z.object({ feedUrl: z.string().url().max(1200) }).strict().parse(req.body);
  if (!approvedDiscoveryFeeds.includes(input.feedUrl)) return res.status(403).json({ error: "Feed is not approved" });
  let entries;
  try {
    entries = await discoverFeed({ url: input.feedUrl, approvedSources: approvedDiscoveryFeeds });
  } catch (error) {
    if (!(error instanceof DiscoverySourceError)) throw error;
    console.warn("[discovery] Scan blocked:", error.code, "stage:", error.stage);
    return res.status(error.status).json({
      error: "Discovery source unavailable",
      code: error.code,
      stage: error.stage,
    });
  }
  res.json({ entries: entries.map((entry) => signScanEntry(entry, env.SESSION_SIGNING_KEY)), providerCost: 0, requiresReview: true });
}));
app.post("/api/discovery/import", authenticated, requireOrigin, safe(async (req, res) => {
  const schema = z.object({
    feedUrl: z.string().url().max(1200),
    name: z.string().trim().min(2).max(160),
    sourceUrl: z.string().url().max(2048),
    discoveryKey: z.string().length(64).regex(/^[a-f0-9]+$/),
    proof: z.string().max(128),
    category: z.enum(Object.keys(EXPERT_CATEGORIES)),
  }).strict();
  const input = schema.parse(req.body);
  if (!approvedDiscoveryFeeds.includes(input.feedUrl)) return res.status(403).json({ error: "Feed is not approved" });
  const candidate = normalizeCandidate({
    name: input.name, sourceUrl: input.sourceUrl, category: input.category, onlineEnglish: false,
  });
  // Signed scan proof authenticates the original discovery key, normalized name
  // and article URL. Do not recalculate the key from a display-normalized byline:
  // old imports use the publisher's raw author representation.
  if (!verifyScanEntry(input, env.SESSION_SIGNING_KEY)) {
    return res.status(403).json({ error: "Valid recent scan evidence is required" });
  }
  const discoveryKey = input.discoveryKey;
  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
      const existing = await tx.candidate.findFirst({ where: { workspaceId: null, discoveryKey } });
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
    const winner = await prisma.candidate.findFirst({ where: { workspaceId: null, discoveryKey } });
    if (!winner) throw error;
    result = { id: winner.id, created: false };
  }
  res.status(result.created ? 201 : 200).json(result);
}));
// Review is an explicit administrative attestation, not an inference from an RSS
// byline. Keep the original article URL unchanged as source provenance.
app.patch("/api/candidates/:id/expert-review", candidateReadScope, requireOrigin,
  safe(async (req, res) => {
    const input = z.object({
      expertProfileUrl: z.string().url().max(2048),
      region: z.enum(["US", "UK_IRELAND", "OTHER_ENGLISH_SPEAKING"]).nullable(),
      onlineEnglish: z.boolean(),
      profileReviewed: z.literal(true),
    }).strict().parse(req.body);
    const actorId = req.candidateScope === null ? "admin" :
      verifyPartnerSession(req.cookies?.pilot_partner_session, env.SESSION_SIGNING_KEY);
    const result = await prisma.$transaction(async tx => {
      // Serialize revocation against the entire read-modify-write transaction.
      if (req.candidateScope !== null && !await lockActiveWorkspaceMembership(tx, {
        userId: actorId, workspaceId: req.candidateScope,
      })) return { status: 403, error: "Workspace membership revoked" };
      const row = await tx.candidate.findFirst({
        where: { id: req.params.id, workspaceId: req.candidateScope },
      });
      if (!row) return { status: 404, error: "Candidate not found" };
      if (!row.discoveryKey) return { status: 409, error: "Only discovered candidates use this review flow" };
      if (row.suppressed) return { status: 409, error: "Suppressed candidate cannot be reviewed" };
      if (input.expertProfileUrl === row.sourceUrl) {
        return { status: 400, error: "Expert profile must be distinct from article evidence" };
      }
      // Keep original byline/source provenance and existing domain validation.
      const verified = normalizeCandidate({ ...row, ...input });
      if (!verified.expertProfileUrl) return { status: 400, error: "Expert profile URL required" };
      const changed = row.expertProfileUrl !== verified.expertProfileUrl ||
        !row.profileReviewed || row.onlineEnglish !== verified.onlineEnglish ||
        row.region !== verified.region;
      if (!changed) return { status: 200, reviewed: true, changed: false };
      await tx.candidate.update({
        where: { id: row.id },
        data: {
          name: normalizeFeedAuthor(row.name),
          expertProfileUrl: verified.expertProfileUrl,
          profileReviewed: true,
          onlineEnglish: verified.onlineEnglish,
          region: verified.region,
          status: "REVIEWED",
        },
      });
      await tx.auditEvent.create({ data: {
        actorId, action: "discovery.expert.reviewed", entityId: row.id,
        metadata: { profileUrl: verified.expertProfileUrl, articleUrl: row.sourceUrl,
          onlineEnglish: verified.onlineEnglish, region: verified.region },
      } });
      return { status: 200, reviewed: true, changed: true };
    });
    return res.status(result.status).json(result);
  }));
// Append-only source observations. An observation never auto-confirms
// eligibility, ownership of the identity, or consent to contact.
app.get("/api/candidates/:id/evidence", candidateReadScope, safe(async (req, res) => {
  const candidate = await prisma.candidate.findFirst({
    where: { id: req.params.id, workspaceId: req.candidateScope },
    select: { id: true },
  });
  if (!candidate) return res.status(404).json({ error: "Candidate not found" });
  const items = await prisma.candidateEvidence.findMany({
    where: { candidateId: candidate.id, workspaceId: req.candidateScope },
    orderBy: { capturedAt: "asc" }, take: 100,
  });
  return res.json(items);
}));
app.post("/api/candidates/:id/evidence", candidateReadScope, requireOrigin, safe(async (req, res) => {
  const input = z.object({
    kind: z.enum(EVIDENCE_KINDS),
    sourceUrl: z.string().url().max(2048),
    note: z.string().trim().max(500).optional(),
  }).strict().parse(req.body);
  const normalizedUrl = canonicalEvidenceUrl(input.sourceUrl);
  const actorId = req.candidateScope === null ? "admin" :
    verifyPartnerSession(req.cookies?.pilot_partner_session, env.SESSION_SIGNING_KEY);
  const key = { candidateId_kind_normalizedUrl: {
    candidateId: req.params.id, kind: input.kind, normalizedUrl,
  } };
  const result = await prisma.$transaction(async tx => {
    if (req.candidateScope !== null && !await lockActiveWorkspaceMembership(tx, {
      workspaceId: req.candidateScope, userId: actorId,
    })) return { status: 403, body: { error: "Workspace membership revoked" } };
    const row = await tx.candidate.findFirst({
      where: { id: req.params.id, workspaceId: req.candidateScope }, select: { id: true },
    });
    if (!row) return { status: 404, body: { error: "Candidate not found" } };
    const existing = await tx.candidateEvidence.findUnique({ where: key });
    if (existing) return { status: 200, body: { id: existing.id, created: false } };
    const observation = await tx.candidateEvidence.create({ data: {
      workspaceId: req.candidateScope,
      candidateId: row.id, kind: input.kind, sourceUrl: input.sourceUrl,
      normalizedUrl, note: input.note ?? null, capturedBy: actorId,
    } });
    await tx.auditEvent.create({ data: {
      actorId, action: "candidate.evidence.added", entityId: row.id,
      metadata: { evidenceId: observation.id, kind: input.kind, sourceUrl: normalizedUrl },
    } });
    return { status: 201, body: { id: observation.id, created: true } };
  }).catch(async error => {
    if (error?.code !== "P2002") throw error;
    // A concurrent insert can only be reused for the exact candidate
    // identified by this request, and a revoked partner may not view it.
    if (req.candidateScope !== null && !await requireWorkspaceMembership(prisma, {
      workspaceId: req.candidateScope, userId: actorId,
    })) return { status: 403, body: { error: "Workspace membership revoked" } };
    const candidate = await prisma.candidate.findFirst({
      where: { id: req.params.id, workspaceId: req.candidateScope }, select: { id: true },
    });
    if (!candidate) return { status: 404, body: { error: "Candidate not found" } };
    const existing = await prisma.candidateEvidence.findUnique({ where: key });
    if (!existing) throw error;
    return { status: 200, body: { id: existing.id, created: false } };
  });
  return res.status(result.status).json(result.body);
}));
// Independently inspect the candidate's existing public individual profile.
// Only an explicit published Name + Email pair becomes REVIEW_REQUIRED evidence.
// Client input cannot supply names, URLs, addresses, or inspection results.
app.post("/api/candidates/:id/direct-email-evidence", candidateReadScope,
  requireOrigin, researchLimiter, safe(async (req, res) => {
    if (req.candidateScope === null) {
      return res.status(403).json({ error: "Partner workspace required" });
    }
    const identity = await partnerIdentity(req);
    if (!identity) return res.status(401).json({ error: "Unauthorized" });
    z.object({}).strict().parse(req.body ?? {});
    const outcome = await inspectAndStoreDirectEmailObservation(prisma, {
      candidateId: req.params.id, workspaceId: req.candidateScope,
      ownerId: identity.id,
    });
    res.set("Cache-Control", "no-store");
    return res.status(outcome.status).json(outcome.status === 200 ?
      outcome : { code: outcome.code, error: "Person-email evidence unavailable" });
  }));

app.get("/api/candidates/:id/direct-email-evidence", candidateReadScope,
  safe(async (req, res) => {
    if (req.candidateScope === null) {
      return res.status(403).json({ error: "Partner workspace required" });
    }
    const identity = await partnerIdentity(req);
    if (!identity) return res.status(401).json({ error: "Unauthorized" });
    const row = await prisma.candidate.findFirst({
      where: { id: req.params.id, workspaceId: req.candidateScope },
      select: { id: true, name: true, email: true, expertProfileUrl: true },
    });
    if (!row) return res.status(404).json({ error: "Candidate not found" });
    const stored = await prisma.candidateDirectEmailObservation.findUnique({
      where: { candidateId: row.id },
    });
    res.set("Cache-Control", "no-store");
    const snapshot = directEmailReviewSnapshot(row, stored);
    return res.json({
      candidateId: row.id,
      observation: snapshot,
      personEmailLinked: snapshot?.personEmailLinked === true,
      usableAsContact: false,
      onboardingEligible: false,
      sendingEnabled: false,
    });
  }));

// A reviewer confirms ONLY one immutable, independently inspected
// Name + Email evidence snapshot; this never authorizes mailing.
app.post("/api/candidates/:id/direct-email-evidence/review",
  candidateReadScope, requireOrigin, safe(async (req, res) => {
    if (req.candidateScope === null) {
      return res.status(403).json({ error: "Partner workspace required" });
    }
    const identity = await partnerIdentity(req);
    if (!identity) return res.status(401).json({ error: "Unauthorized" });
    const input = z.object({
      expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
      confirmsExactPersonEmailPair: z.literal(true),
    }).strict().parse(req.body);
    const result = await reviewCandidateDirectEmailEvidence(prisma, {
      candidateId: req.params.id,
      workspaceId: req.candidateScope, ownerId: identity.id,
      expectedDigest: input.expectedDigest,
    });
    res.set("Cache-Control", "no-store");
    return res.status(result.status).json(result);
  }));

// Exact matches are review hints, not automatic identity merges. No name-only matches.
// Scoped read-only preflight: DNS routing is not mailbox verification.
// Never accepts arbitrary email input and never sends a probe or stores PII.
app.get("/api/candidates/:id/email-check", candidateReadScope,
  researchLimiter, safe(async (req, res) => {
    const identity = req.candidateScope === null ? null : await partnerIdentity(req);
    if (req.candidateScope !== null && !identity) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const row = await prisma.candidate.findFirst({
      where: { id: req.params.id, workspaceId: req.candidateScope },
      select: { id: true, email: true, suppressed: true,
        contactReviewed: true, legalBasis: true },
    });
    if (!row) return res.status(404).json({ error: "Candidate not found" });
    const saved = await prisma.candidateEmailVerification.findUnique({
      where: { candidateId: row.id },
    });
    const cached = visibleCandidateDnsSnapshot(row, saved);
    const inspection = cached ?? await inspectEmailDomain(row.email);
    // Domain routing does not establish verified mailbox ownership.
    // Neither a VALID syntax nor an MX record grants onboarding eligibility.
    const eligibility = onboardingEmailEligibility(row, {
      email: row.email, status: inspection.status, checkedAt: new Date(),
    });
    res.set("Cache-Control", "no-store");
    return res.json({
      candidateId: row.id, syntaxAndDomain: inspection,
      cachedDnsVerification: cached !== null,
      mailboxVerified: false, personEmailLinked: false,
      usableAsContact: false, onboardingEligible: false,
      blockers: eligibility.blockers, sendingEnabled: false,
    });
  }));

// Explicit DNS check writes only an email-bound domain-routing observation.
// It never validates a mailbox or enrolls a recipient.
app.post("/api/candidates/:id/email-check", candidateReadScope,
  requireOrigin, researchLimiter, safe(async (req, res) => {
    if (req.candidateScope === null) {
      return res.status(403).json({ error: "Partner workspace required" });
    }
    const identity = await partnerIdentity(req);
    if (!identity) return res.status(401).json({ error: "Unauthorized" });
    z.object({}).strict().parse(req.body ?? {});
    const outcome = await inspectAndPersistCandidateDns(prisma, {
      candidateId: req.params.id, workspaceId: req.candidateScope,
      ownerId: identity.id,
    });
    res.set("Cache-Control", "no-store");
    return res.status(outcome.status).json(outcome.status === 200 ?
      outcome : { code: outcome.code, error: "Candidate DNS check unavailable" });
  }));

app.get("/api/candidates/:id/possible-duplicates", candidateReadScope, safe(async (req, res) => {
  const candidate = await prisma.candidate.findFirst({
    where: { id: req.params.id, workspaceId: req.candidateScope },
  });
  if (!candidate) return res.status(404).json({ error: "Candidate not found" });
  if (!candidate.expertProfileUrl && !candidate.emailNormalized) {
    return res.json({ suggestions: [], automaticallyMerged: false, incomplete: false });
  }
  // Identity hints must never disclose candidates from another workspace.
  // Bounded scanning is still explicitly incomplete when a tenant exceeds cap.
  const MAX_IDENTITY_CANDIDATES = 500;
  const others = await prisma.candidate.findMany({
    where: { workspaceId: req.candidateScope, id: { not: candidate.id } },
    select: { id: true, emailNormalized: true, expertProfileUrl: true },
    orderBy: { id: "asc" },
    take: MAX_IDENTITY_CANDIDATES + 1,
  });
  const incomplete = others.length > MAX_IDENTITY_CANDIDATES;
  const suggestions = sameIdentityHints(candidate, others.slice(0, MAX_IDENTITY_CANDIDATES));
  return res.json({ suggestions, automaticallyMerged: false, incomplete });
}));
// Planning is inert: it persists tasks but makes no provider request.
// Feature flag defaults off until a leased executor and spending gates ship.
app.post("/api/research-campaigns", candidateReadScope, requireOrigin,
  safe(async (req, res) => {
    if (env.AI_AGENT_RESEARCH_ENABLED !== "true") {
      return res.status(503).json({ code: "RESEARCH_CAMPAIGNS_DISABLED",
        error: "Research campaigns are not enabled" });
    }
    if (req.candidateScope === null) {
      return res.status(403).json({ error: "Partner workspace required" });
    }
    const identity = await partnerIdentity(req);
    if (!identity) return res.status(401).json({ error: "Unauthorized" });
    const plan = planResearchCampaign(req.body);
    const result = await prisma.$transaction(async tx => {
      if (!await lockActiveWorkspaceMembership(tx, {
        workspaceId: req.candidateScope, userId: identity.id,
      })) return null;
      // Serialize an identical request against the workspace row. No new
      // campaign or duplicate tasks are created when the client retries.
      await tx.$queryRaw`SELECT "id" FROM "Partner"
        WHERE "id" = ${req.candidateScope} FOR UPDATE`;
      const existing = await tx.researchCampaign.findUnique({
        where: { workspaceId_ownerId_idempotencyKey: {
          workspaceId: req.candidateScope, ownerId: identity.id,
          idempotencyKey: plan.idempotencyKey,
        } },
      });
      if (existing) {
        if (existing.query !== plan.query || existing.targetCount !== plan.targetCount ||
            existing.planVersion !== plan.planVersion) {
          return { conflict: true };
        }
        return { campaign: existing, created: false };
      }
      const campaign = await tx.researchCampaign.create({ data: {
        workspaceId: req.candidateScope, ownerId: identity.id,
        idempotencyKey: plan.idempotencyKey, query: plan.query,
        targetCount: plan.targetCount, planVersion: plan.planVersion,
        tasks: { create: plan.tasks.map(task => ({
          taskIndex: task.index, taskKey: task.key, query: task.query,
          region: task.region, facet: task.facet, resultLimit: task.limit,
        })) },
      } });
      await tx.auditEvent.create({ data: {
        actorId: identity.id, action: "research.campaign.planned",
        entityId: campaign.id,
        metadata: { workspaceId: req.candidateScope,
          planVersion: plan.planVersion, tasks: plan.tasks.length,
          targetCount: plan.targetCount },
      } });
      return { campaign, created: true };
    });
    if (!result) return res.status(403).json({ error: "Workspace membership revoked" });
    if (result.conflict) return res.status(409).json({
      error: "Idempotency key already used for different campaign criteria",
    });
    return res.status(result.created ? 201 : 200).json({
      id: result.campaign.id, created: result.created,
      status: result.campaign.status, targetCount: result.campaign.targetCount,
      plannedTasks: plan.tasks.length, providerCallsAuthorized: false,
      sendingEnabled: false,
    });
  }));

app.get("/api/research-campaigns", candidateReadScope, safe(async (req, res) => {
  if (req.candidateScope === null) {
    return res.status(403).json({ error: "Partner workspace required" });
  }
  const identity = await partnerIdentity(req);
  if (!identity) return res.status(401).json({ error: "Unauthorized" });
  const items = await prisma.researchCampaign.findMany({
    where: { workspaceId: req.candidateScope, ownerId: identity.id },
    select: { id: true, query: true, targetCount: true, planVersion: true,
      status: true, createdAt: true, _count: { select: { tasks: true, observations: true } } },
    orderBy: { createdAt: "desc" }, take: 30,
  });
  return res.json(items.map(item => ({
    id: item.id, query: item.query, targetCount: item.targetCount,
    planVersion: item.planVersion, status: item.status,
    createdAt: item.createdAt, plannedTasks: item._count.tasks,
    uniqueSourcedCandidates: item._count.observations,
    providerCallsAuthorized: false,
  })));
}));

// Reporting reads only committed provider-cited observations, never draft
// contacts or automatically approved recipients.
app.get("/api/research-campaigns/:id/progress", candidateReadScope,
  safe(async (req, res) => {
    if (req.candidateScope === null) {
      return res.status(403).json({ error: "Partner workspace required" });
    }
    const identity = await partnerIdentity(req);
    if (!identity) return res.status(401).json({ error: "Unauthorized" });
    const campaign = await prisma.researchCampaign.findFirst({
      where: { id: req.params.id, workspaceId: req.candidateScope,
        ownerId: identity.id },
      select: { id: true, status: true, targetCount: true,
        _count: { select: { observations: true } },
        tasks: { select: { status: true, observedCount: true,
          resultLimit: true, leaseUntil: true, nextAttemptAt: true,
          taskIndex: true, lastErrorCode: true } } },
    });
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    res.set("Cache-Control", "no-store");
    return res.json(summarizeCampaignProgress(campaign));
  }));

// Per-campaign manual sources reuse the owner-scoped campaign and membership
// contracts. Persist inputs only: no model invocation, web fetch, contact or email.
app.get("/api/research-campaigns/:id/sources", candidateReadScope,
  safe(async (req, res) => {
    if (req.candidateScope === null) return res.status(403).json({
      error: "Partner workspace required",
    });
    const identity = await partnerIdentity(req);
    if (!identity) return res.status(401).json({ error: "Unauthorized" });
    const campaign = await prisma.researchCampaign.findFirst({
      where: { id: req.params.id, workspaceId: req.candidateScope,
        ownerId: identity.id }, select: { id: true },
    });
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    const sources = await prisma.researchCampaignSource.findMany({
      where: { campaignId: campaign.id },
      select: { id: true, normalizedUrl: true, sourceKind: true,
        status: true, createdAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 200,
    });
    res.set("Cache-Control", "no-store");
    return res.json({ sources, inspected: false, providerCallsAuthorized: false });
  }));

app.post("/api/research-campaigns/:id/sources", candidateReadScope,
  requireOrigin, researchLimiter, safe(async (req, res) => {
    if (req.candidateScope === null) return res.status(403).json({
      error: "Partner workspace required",
    });
    const identity = await partnerIdentity(req);
    if (!identity) return res.status(401).json({ error: "Unauthorized" });
    const urls = normalizeManualResearchSources(req.body);
    const result = await prisma.$transaction(async tx => {
      if (!await lockActiveWorkspaceMembership(tx, {
        workspaceId: req.candidateScope, userId: identity.id,
      })) return null;
      return enqueueManualResearchSources(tx, {
        campaignId: req.params.id, workspaceId: req.candidateScope,
        ownerId: identity.id, urls,
      });
    });
    if (!result) return res.status(403).json({ error: "Workspace membership revoked" });
    if (!result.found) return res.status(404).json({ error: "Campaign not found" });
    res.set("Cache-Control", "no-store");
    return res.status(result.added ? 201 : 200).json({
      added: result.added, submitted: result.submitted,
      status: "PENDING_ENRICHMENT", providerCallsAuthorized: false,
      inspected: false, contactsCreated: 0,
    });
  }));

app.get("/api/research-campaigns/:id/observations", candidateReadScope,
  safe(async (req, res) => {
    if (req.candidateScope === null) {
      return res.status(403).json({ error: "Partner workspace required" });
    }
    const identity = await partnerIdentity(req);
    if (!identity) return res.status(401).json({ error: "Unauthorized" });
    const cursor = z.object({
      after: z.string().regex(/^c[a-z0-9]{10,40}$/).optional(),
    }).strict().parse(req.query).after;
    const campaign = await prisma.researchCampaign.findFirst({
      where: { id: req.params.id, workspaceId: req.candidateScope,
        ownerId: identity.id },
      select: { id: true },
    });
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    const rows = await prisma.researchCampaignObservation.findMany({
      where: { campaignId: campaign.id, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: { id: true, name: true, category: true, citationUrl: true,
        rationale: true, status: true, observedAt: true, candidateId: true,
        emailTriageStatus: true, emailTriageCode: true,
        emailTriageEmail: true, emailTriageAt: true },
      orderBy: { id: "asc" }, take: 101,
    });
    const page = rows.slice(0, 100);
    res.set("Cache-Control", "no-store");
    return res.json({
      observations: page,
      nextCursor: rows.length > 100 ? page[page.length - 1].id : null,
      verifiedContacts: 0,
      sendingEnabled: false,
    });
  }));

// Provider-cited grounding HEAD requests are separately owner-authorized.
// All side effects remain OFF unless explicitly enabled on this server.
app.post("/api/research-campaigns/:id/grounding/start",
  candidateReadScope, requireOrigin, researchLimiter, safe(async (req, res) => {
    if (env.AI_GROUNDING_RESOLUTION_ENABLED !== "true") {
      return res.status(503).json({ code: "GROUNDING_RESOLUTION_DISABLED" });
    }
    if (req.candidateScope === null) return res.status(403).json({
      error: "Partner workspace required",
    });
    const identity = await partnerIdentity(req);
    if (!identity) return res.status(401).json({ error: "Unauthorized" });
    const input = z.object({
      maxSources: z.number().int().min(1).max(250),
      confirmPublicRequests: z.literal(true),
    }).strict().parse(req.body ?? {});
    const result = await approveGroundingResolution(prisma, {
      campaignId: req.params.id, workspaceId: req.candidateScope,
      ownerId: identity.id, ...input,
    });
    res.set("Cache-Control", "no-store");
    return res.status(result.status).json(result);
  }));

app.post("/api/research-campaigns/:id/grounding/stop",
  candidateReadScope, requireOrigin, researchLimiter, safe(async (req, res) => {
    if (req.candidateScope === null) return res.status(403).json({
      error: "Partner workspace required",
    });
    const identity = await partnerIdentity(req);
    if (!identity) return res.status(401).json({ error: "Unauthorized" });
    z.object({ confirmStop: z.literal(true) }).strict().parse(req.body ?? {});
    const result = await stopGroundingResolution(prisma, {
      campaignId: req.params.id, workspaceId: req.candidateScope,
      ownerId: identity.id,
    });
    res.set("Cache-Control", "no-store");
    return res.status(result.status).json(result);
  }));

app.get("/api/research-campaigns/:id/grounding",
  candidateReadScope, safe(async (req, res) => {
    if (req.candidateScope === null) return res.status(403).json({
      error: "Partner workspace required",
    });
    const identity = await partnerIdentity(req);
    if (!identity) return res.status(401).json({ error: "Unauthorized" });
    const summary = await groundingResolutionSummary(prisma, {
      campaignId: req.params.id, workspaceId: req.candidateScope,
      ownerId: identity.id,
    }, { enabled: env.AI_GROUNDING_RESOLUTION_ENABLED === "true" });
    if (!summary) return res.status(404).json({ code: "CAMPAIGN_NOT_FOUND" });
    res.set("Cache-Control", "no-store");
    return res.json({
      ...summary, enabled: env.AI_GROUNDING_RESOLUTION_ENABLED === "true",
    });
  }));

// Public-profile inspection is a separate non-AI, non-contact workflow.
// A completed discovery campaign can receive one immutable owner approval.
app.post("/api/research-campaigns/:id/email-triage/start",
  candidateReadScope, requireOrigin, researchLimiter, safe(async (req, res) => {
    if (env.AI_EMAIL_TRIAGE_ENABLED !== "true") {
      return res.status(503).json({ code: "EMAIL_TRIAGE_DISABLED" });
    }
    if (req.candidateScope === null) return res.status(403).json({
      error: "Partner workspace required",
    });
    const identity = await partnerIdentity(req);
    if (!identity) return res.status(401).json({ error: "Unauthorized" });
    const input = z.object({
      maxPages: z.number().int().min(1).max(250),
      confirmPublicInspection: z.literal(true),
      confirmSkipUninspectable: z.literal(true).optional(),
    }).strict().parse(req.body ?? {});
    const result = await approveEmailTriage(prisma, {
      campaignId: req.params.id, workspaceId: req.candidateScope,
      ownerId: identity.id, ...input,
    });
    res.set("Cache-Control", "no-store");
    return res.status(result.status).json(result);
  }));

app.post("/api/research-campaigns/:id/email-triage/stop",
  candidateReadScope, requireOrigin, researchLimiter, safe(async (req, res) => {
    if (req.candidateScope === null) return res.status(403).json({
      error: "Partner workspace required",
    });
    const identity = await partnerIdentity(req);
    if (!identity) return res.status(401).json({ error: "Unauthorized" });
    z.object({ confirmStop: z.literal(true) }).strict().parse(req.body ?? {});
    const result = await stopEmailTriage(prisma, {
      campaignId: req.params.id, workspaceId: req.candidateScope,
      ownerId: identity.id,
    });
    res.set("Cache-Control", "no-store");
    return res.status(result.status).json(result);
  }));

app.get("/api/research-campaigns/:id/email-triage",
  candidateReadScope, safe(async (req, res) => {
    if (req.candidateScope === null) return res.status(403).json({
      error: "Partner workspace required",
    });
    const identity = await partnerIdentity(req);
    if (!identity) return res.status(401).json({ error: "Unauthorized" });
    const campaign = await prisma.researchCampaign.findFirst({
      where: { id: req.params.id, workspaceId: req.candidateScope,
        ownerId: identity.id },
      select: { id: true, status: true, emailTriageStatus: true,
        emailTriageMaxPages: true, emailTriageExpiresAt: true },
    });
    if (!campaign) return res.status(404).json({ code: "CAMPAIGN_NOT_FOUND" });
    const counts = await prisma.researchCampaignObservation.groupBy({
      by: ["emailTriageStatus"], where: { campaignId: campaign.id },
      _count: { id: true },
    });
    // This is read-only and owner-scoped. Never return source URLs from the
    // preflight or interpret inspectable as independently verified identity.
    const savedSources = await prisma.researchCampaignObservation.findMany({
      where: { campaignId: campaign.id },
      select: { id: true, citationUrl: true, groundingStatus: true,
        groundingResolvedUrl: true, groundingProvenance: true,
        name: true, category: true, emailTriageStatus: true,
        emailTriageCode: true, emailTriageEmail: true,
        emailTriageDigest: true, emailTriageAt: true,
        personSourceUrl: true, personSourceProvenance: true,
        personSourceVerifiedAt: true },
      take: 251,
    });
    res.set("Cache-Control", "no-store");
    return res.json({
      ...emailTriageSummary(campaign, counts),
      preflight: emailTriageSourceReadiness(campaign.status, savedSources),
      qualification: summarizeQualifiedEmailEvidence(savedSources),
      sourceResolution: publicPersonSourcePlan(
        planPersonSourceResolution(savedSources, { maxJobs: 0 })),
      enabled: env.AI_EMAIL_TRIAGE_ENABLED === "true",
    });
  }));

// Explicit single-observation inspection using the existing bounded public
// page reader. This does not use AI, write contacts or send invitations.
app.post("/api/research-campaigns/:id/observations/:observationId/email-evidence",
  candidateReadScope, requireOrigin, researchLimiter, safe(async (req, res) => {
    if (req.candidateScope === null) {
      return res.status(403).json({ error: "Partner workspace required" });
    }
    const identity = await partnerIdentity(req);
    if (!identity) return res.status(401).json({ error: "Unauthorized" });
    z.object({}).strict().parse(req.body ?? {});
    const result = await inspectCampaignObservationEmail(prisma, {
      campaignId: req.params.id, observationId: req.params.observationId,
      workspaceId: req.candidateScope, ownerId: identity.id,
    });
    res.set("Cache-Control", "no-store");
    return res.status(result.status).json(result);
  }));

// A reviewer explicitly accepts one freshly re-inspected, attributable
// person-email evidence snapshot. No email or mismatched digest => NO contact.
app.post("/api/research-campaigns/:id/observations/:observationId/accept-contact",
  candidateReadScope, requireOrigin, researchLimiter, safe(async (req, res) => {
    if (req.candidateScope === null) {
      return res.status(403).json({ error: "Partner workspace required" });
    }
    const identity = await partnerIdentity(req);
    if (!identity) return res.status(401).json({ error: "Unauthorized" });
    const input = z.object({
      expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
      confirmsExactPersonEmailPair: z.literal(true),
    }).strict().parse(req.body ?? {});
    const result = await acceptReviewedCampaignContact(prisma, {
      campaignId: req.params.id, observationId: req.params.observationId,
      workspaceId: req.candidateScope, ownerId: identity.id, ...input,
    });
    res.set("Cache-Control", "no-store");
    return res.status(result.status).json(result);
  }));

// Explicitly invoked one-task executor. Both flags are OFF by default;
// nothing schedules background work or permits autonomous paid requests.
// New opt-in autonomous approval. Feature flag is OFF by default.
// Only a clean, not-yet-executed campaign may be approved; all prices
// and immutable attempt/cost caps come from verified server-side policy.
// Separate, immutable source-enrichment budget. OFF by default; no provider
// dispatch is wired here. Approval is not an outreach or contact permission.
app.post("/api/research-campaigns/:id/person-source/approve",
  candidateReadScope, requireOrigin, researchLimiter, safe(async (req, res) => {
    if (env.AI_PERSON_SOURCE_APPROVAL_ENABLED !== "true") {
      return res.status(503).json({ code: "PERSON_SOURCE_APPROVAL_DISABLED" });
    }
    if (req.candidateScope === null) return res.status(403).json({
      error: "Partner workspace required",
    });
    const identity = await partnerIdentity(req);
    if (!identity) return res.status(401).json({ error: "Unauthorized" });
    const input = z.object({
      maxCalls: z.number().int().min(1).max(250),
      maxWorstCaseCents: z.number().int().min(1).max(50000),
      confirmPaidSourceResearch: z.literal(true),
      confirmNoAutomaticRetry: z.literal(true),
      confirmPublicInspection: z.literal(true),
    }).strict().parse(req.body ?? {});
    const result = await approvePersonSourceResearch(prisma, {
      campaignId: req.params.id, workspaceId: req.candidateScope,
      ownerId: identity.id, input,
    });
    res.set("Cache-Control", "no-store");
    return res.status(result.status).json(result);
  }));

app.post("/api/research-campaigns/:id/approve-run",
  candidateReadScope, requireOrigin, researchLimiter, safe(async (req, res) => {
    if (env.AI_AGENT_RESEARCH_ENABLED !== "true" ||
        env.AI_AGENT_EXECUTOR_ENABLED !== "true" ||
        env.AI_AGENT_AUTORUN_ENABLED !== "true") {
      return res.status(503).json({ code: "AUTONOMOUS_RUN_DISABLED" });
    }
    if (req.candidateScope === null) return res.status(403).json({
      error: "Partner workspace required",
    });
    const identity = await partnerIdentity(req);
    if (!identity) return res.status(401).json({ error: "Unauthorized" });
    const result = await approveCampaignRun(prisma, {
      campaignId: req.params.id, workspaceId: req.candidateScope,
      ownerId: identity.id, input: req.body,
    });
    res.set("Cache-Control", "no-store");
    return res.status(result.status).json(result);
  }));

app.post("/api/research-campaigns/:id/approved-run/stop",
  candidateReadScope, requireOrigin, researchLimiter, safe(async (req, res) => {
    if (req.candidateScope === null) return res.status(403).json({
      error: "Partner workspace required",
    });
    const identity = await partnerIdentity(req);
    if (!identity) return res.status(401).json({ error: "Unauthorized" });
    z.object({ confirmStop: z.literal(true) }).strict().parse(req.body ?? {});
    const result = await stopApprovedCampaignRun(prisma, {
      campaignId: req.params.id, workspaceId: req.candidateScope,
      ownerId: identity.id,
    });
    res.set("Cache-Control", "no-store");
    return res.status(result.status).json(result);
  }));

app.get("/api/research-campaigns/:id/approved-run",
  candidateReadScope, safe(async (req, res) => {
    if (req.candidateScope === null) return res.status(403).json({
      error: "Partner workspace required",
    });
    const identity = await partnerIdentity(req);
    if (!identity) return res.status(401).json({ error: "Unauthorized" });
    const campaign = await prisma.researchCampaign.findFirst({
      where: { id: req.params.id, workspaceId: req.candidateScope,
        ownerId: identity.id }, select: { id: true },
    });
    if (!campaign) return res.status(404).json({ code: "CAMPAIGN_NOT_FOUND" });
    const run = await prisma.researchCampaignRun.findUnique({
      where: { campaignId: campaign.id },
    });
    let priceEnvelope = null;
    if (!run && env.AI_AGENT_AUTORUN_ENABLED === "true") {
      const setting = await prisma.aiSetting.findUnique({
        where: { ownerId: identity.id },
        select: { provider: true, model: true },
      });
      if (setting) {
        try {
          const price = requireResearchPriceEnvelope(setting);
          priceEnvelope = {
            provider: setting.provider, model: setting.model,
            worstCasePerCallCents: price.worstCaseCents,
            priceVersion: price.priceVersion,
          };
        } catch {
          // An unavailable price policy never enables paid approval.
        }
      }
    }
    res.set("Cache-Control", "no-store");
    return res.json({ run: run ? publicRunStatus(run) : null,
      priceEnvelope,
      autonomousRunEnabled: env.AI_AGENT_AUTORUN_ENABLED === "true" &&
        env.AI_AGENT_RESEARCH_ENABLED === "true" &&
        env.AI_AGENT_EXECUTOR_ENABLED === "true",
      sendingEnabled: false });
  }));

app.post("/api/research-campaigns/:id/execute-next",
  candidateReadScope, requireOrigin, campaignExecutionLimiter, safe(async (req, res) => {
    if (env.AI_AGENT_RESEARCH_ENABLED !== "true" ||
        env.AI_AGENT_EXECUTOR_ENABLED !== "true") {
      return res.status(503).json({ code: "RESEARCH_EXECUTOR_DISABLED",
        error: "Research campaign execution is disabled" });
    }
    if (req.candidateScope === null) {
      return res.status(403).json({ error: "Partner workspace required" });
    }
    const identity = await partnerIdentity(req);
    if (!identity) return res.status(401).json({ error: "Unauthorized" });
    // Explicit maxTasks is bounded to 3 paid calls. Omitted maxTasks
    // preserves the existing single-task response contract.
    const input = z.object({ maxTasks: z.number().int().min(1).max(3).optional() })
      .strict().parse(req.body ?? {});
    try {
      const runTask = () => runOneCampaignTask(prisma, {
        campaignId: req.params.id, workspaceId: req.candidateScope,
        ownerId: identity.id, encryptionKey: env.AI_ENCRYPTION_KEY,
      });
      if ((input.maxTasks ?? 1) > 1) {
        const slice = await runBoundedCampaignSlice({ maxTasks: input.maxTasks },
          { runTask });
        if (slice.status === "WAITING" && slice.code === "RESEARCH_PACING_WAIT") {
          res.set("Retry-After", String(slice.retryAfterSeconds));
          return res.status(429).json({
            ...slice, error: "AI request pacing is active; completed tasks remain saved. No additional paid call was started.",
          });
        }
        if (slice.status !== "SLICE_COMPLETED") {
          return res.status(409).json({
            ...slice, error: "Campaign halted; inspect progress, lease and spend before retrying",
          });
        }
        return res.json(slice);
      }
      const output = await runTask();
      if (output.status === "NO_READY_TASK") {
        return res.status(409).json({ code: "RESEARCH_NO_READY_TASK",
          error: "No queued task is ready; check campaign progress" });
      }
      if (output.status !== "COMPLETED") {
        return res.status(409).json({ code: output.code ?? "RESEARCH_TASK_UNCONFIRMED",
          status: output.status,
          error: "Task needs manual review; inspect campaign progress and spend before retrying" });
      }
      return res.json(output);
    } catch (error) {
      if (error instanceof ApprovedRunBlocked) {
        return res.status(409).json({ code: error.code,
          error: "This campaign has a separate immutable run authorization" });
      }
      if (error instanceof ResearchWorkerPreflightError) {
        return res.status(409).json({ code: error.code,
          error: "AI research settings or limits require attention" });
      }
      if (error instanceof ResearchPacingRequired) {
        res.set("Retry-After", String(error.retryAfterSeconds));
        return res.status(429).json({ code: "RESEARCH_PACING_WAIT",
          retryAfterSeconds: error.retryAfterSeconds,
          error: "No AI call was started. Wait before requesting another task." });
      }
      if (error instanceof ResearchQuotaExceeded ||
          error instanceof ResearchConcurrencyExceeded) {
        return res.status(429).json({ code: error.name,
          error: "Research quota or concurrency limit reached" });
      }
      if (error instanceof ResearchBudgetExceeded ||
          error instanceof ResearchPricingUnavailable) {
        return res.status(409).json({ code: error.name,
          error: "Research monetary budget or pricing is unavailable" });
      }
      throw error;
    }
  }));

// Explicit human skip of one already-uncertain, conservatively settled
// task. It NEVER replays the billable call or refunds its reservation.
app.post("/api/research-campaigns/:id/skip-uncertain-task",
  candidateReadScope, requireOrigin, researchLimiter, safe(async (req, res) => {
    if (env.AI_AGENT_RESEARCH_ENABLED !== "true" ||
        env.AI_AGENT_EXECUTOR_ENABLED !== "true") {
      return res.status(503).json({ code: "RESEARCH_EXECUTOR_DISABLED",
        error: "Research campaign execution is disabled" });
    }
    if (req.candidateScope === null) {
      return res.status(403).json({ error: "Partner workspace required" });
    }
    const identity = await partnerIdentity(req);
    if (!identity) return res.status(401).json({ error: "Unauthorized" });
    const input = z.object({
      taskIndex: z.number().int().min(0).max(99),
      confirmNoRetry: z.literal(true),
      acceptConservativeCharge: z.literal(true),
    }).strict().parse(req.body);
    const result = await skipPausedResearchTask(prisma, {
      campaignId: req.params.id, workspaceId: req.candidateScope,
      ownerId: identity.id, ...input,
    });
    res.set("Cache-Control", "no-store");
    return res.status(result.status).json(result);
  }));

app.post("/api/research-campaigns/:id/cancel", candidateReadScope,
  requireOrigin, safe(async (req, res) => {
    if (req.candidateScope === null) return res.status(403).json({
      error: "Partner workspace required",
    });
    const identity = await partnerIdentity(req);
    if (!identity) return res.status(401).json({ error: "Unauthorized" });
    const outcome = await prisma.$transaction(async tx => {
      if (!await lockActiveWorkspaceMembership(tx, {
        workspaceId: req.candidateScope, userId: identity.id,
      })) return { forbidden: true };
      const campaign = await tx.researchCampaign.findFirst({
        where: { id: req.params.id, workspaceId: req.candidateScope,
          ownerId: identity.id },
      });
      if (!campaign) return { missing: true };
      if (campaign.status === "CANCELLED") return { cancelled: true, changed: false };
      if (campaign.status !== "QUEUED") return { conflict: true };
      await tx.researchCampaign.update({
        where: { id: campaign.id }, data: { status: "CANCELLED" },
      });
      await tx.researchCampaignTask.updateMany({
        where: { campaignId: campaign.id, status: "QUEUED" },
        data: { status: "CANCELLED" },
      });
      await tx.auditEvent.create({ data: {
        actorId: identity.id, action: "research.campaign.cancelled",
        entityId: campaign.id, metadata: { workspaceId: req.candidateScope },
      } });
      return { cancelled: true, changed: true };
    });
    if (outcome.forbidden) return res.status(403).json({
      error: "Workspace membership revoked",
    });
    if (outcome.missing) return res.status(404).json({ error: "Campaign not found" });
    if (outcome.conflict) return res.status(409).json({
      error: "Campaign cannot be cancelled in current state",
    });
    return res.json(outcome);
  }));

app.get("/api/candidates", candidateReadScope, safe(async (req, res) => {
  const items = await prisma.candidate.findMany({
    where: { workspaceId: req.candidateScope },
    orderBy: { createdAt: "desc" }, take: 500,
    include: { directEmailObservation: true, mailboxVerification: true },
  });
  const now = new Date();
  res.set("Cache-Control", "no-store");
  res.json(items.map(({ directEmailObservation, mailboxVerification, ...candidate }) => {
    const projection = projectCandidateContactReadiness(candidate, {
      directEmailObservation, mailboxVerification,
    }, now);
    return {
      ...candidate,
      name: candidate.discoveryKey ? normalizeFeedAuthor(candidate.name) : candidate.name,
      score: scoreCandidate(candidate, projection.evidence),
      qualification: projection.qualification,
      outreach: projection.outreach,
      contactVerification: projection.contactVerification,
    };
  }));
}));
app.post("/api/candidates", candidateReadScope, requireOrigin, safe(async (req, res) => {
  // Ownership comes exclusively from verified session + query membership.
  // Never accept client-submitted ownership fields in candidate payloads.
  if (req.body === null || typeof req.body !== "object" || Array.isArray(req.body) ||
      Object.hasOwn(req.body, "workspaceId")) {
    return res.status(400).json({ error: "Candidate ownership cannot be set in request body" });
  }
  const manualSeed = req.body.manualSeed === true;
  const discoverySeed = req.body.discoverySeed === true;
  if ((manualSeed || discoverySeed) && req.candidateScope === null) {
    return res.status(403).json({ error: "Review intake requires a partner workspace" });
  }
  const seed = manualSeed ? normalizeManualLeadSeed(req.body) :
    discoverySeed ? normalizeDiscoveryLeadSeed(req.body) : null;
  const candidate = seed ? normalizeCandidate({ ...seed, discoverySeed }) :
    normalizeCandidate(req.body);
  const actorId = req.candidateScope === null ? "admin" :
    verifyPartnerSession(req.cookies?.pilot_partner_session, env.SESSION_SIGNING_KEY);
  const row = await prisma.$transaction(async (tx) => {
    if (req.candidateScope !== null) {
      // Re-check membership inside the write transaction. Revocation and
      // membership changes must not silently grant a new workspace write.
      const active = await lockActiveWorkspaceMembership(tx, {
        workspaceId: req.candidateScope, userId: actorId,
      });
      if (!active) return null;
    }
    if (manualSeed || discoverySeed) {
      // Serialize manual seed submissions within one workspace to make a
      // repeated click/retry idempotent even across different app instances.
      await tx.$queryRaw`
        SELECT "id" FROM "Partner" WHERE "id" = ${req.candidateScope} FOR UPDATE`;
      const found = await tx.candidate.findFirst({
        where: discoverySeed ? {
          workspaceId: req.candidateScope, discoveryKey: seed.discoveryKey,
        } : {
          workspaceId: req.candidateScope,
          sourceUrl: candidate.sourceUrl,
          name: { equals: candidate.name, mode: "insensitive" },
        },
        select: { id: true },
      });
      if (found) return { id: found.id, created: false };
    }
    const created = await tx.candidate.create({
      data: {
        workspaceId: req.candidateScope,
        kind: "EXPERT", name: candidate.name, category: candidate.category,
        email: candidate.email, emailNormalized: candidate.email,
        region: candidate.region, onlineEnglish: candidate.onlineEnglish,
        sourceUrl: candidate.sourceUrl, legalBasis: candidate.legalBasis,
        contactReviewed: candidate.contactReviewed, suppressed: candidate.suppressed,
        ...(discoverySeed ? {
          discoveryKey: seed.discoveryKey, researchCitationUrl: seed.researchCitationUrl,
        } : {}),
        ...(manualSeed || discoverySeed ? { status: "REVIEW_PENDING" } : {}),
      },
    });
    await tx.auditEvent.create({ data: {
      actorId, action: discoverySeed ? "candidate.discovery-intake.created" :
        manualSeed ? "candidate.manual-seed.created" : "candidate.created",
      entityId: created.id,
      metadata: { sourceUrl: created.sourceUrl, workspaceId: req.candidateScope,
        ...(discoverySeed ? { citationStatus: "UNVERIFIED_PROVIDER_CITATION" } : {}) },
    } });
    return manualSeed || discoverySeed ? { id: created.id, created: true } : created;
  }).catch(error => {
    if (error?.code === "P2002") return "DUPLICATE";
    throw error;
  });
  if (row === null) return res.status(403).json({ error: "Workspace membership revoked" });
  if (row === "DUPLICATE") return res.status(409).json({ error: "Candidate already exists in workspace" });
  return res.status((manualSeed || discoverySeed) && !row.created ? 200 : 201).json(
    manualSeed || discoverySeed ? { id: row.id, created: row.created } : { id: row.id });
}));

app.get("/api/ai-settings", aiOwnerAuthenticated, safe(async (req, res) => {
  const setting = await prisma.aiSetting.findUnique({ where: { ownerId: req.aiOwnerId } });
  res.json(setting ? {
    provider: setting.provider, model: setting.model,
    keyConfigured: true, fingerprint: setting.keyFingerprint,
  } : { provider: "gemini", model: "gemini-3-flash-preview", keyConfigured: false });
}));
app.put("/api/ai-settings", ...aiWrite, safe(async (req, res) => {
  const input = aiConfigSchema.parse(req.body);
  const existing = await prisma.aiSetting.findUnique({ where: { ownerId: req.aiOwnerId } });
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
      where: { ownerId: req.aiOwnerId },
      create: {
        ownerId: req.aiOwnerId, provider: input.provider, model: input.model,
        encryptedApiKey, keyFingerprint: fingerprint,
      },
      update: { provider: input.provider, model: input.model, encryptedApiKey, keyFingerprint: fingerprint },
    });
    await tx.auditEvent.create({ data: {
      actorId: req.aiOwnerId, action: "ai.settings.updated", entityId: req.aiOwnerId,
      metadata: { provider: input.provider, model: input.model },
    } });
  });
  res.json({ saved: true, keyConfigured: true, fingerprint });
}));
app.delete("/api/ai-settings", ...aiWrite, safe(async (req, res) => {
  await prisma.$transaction(async (tx) => {
    await tx.aiSetting.deleteMany({ where: { ownerId: req.aiOwnerId } });
    await tx.auditEvent.create({ data: {
      actorId: req.aiOwnerId, action: "ai.settings.deleted", entityId: req.aiOwnerId,
    } });
  });
  res.json({ removed: true });
}));

const draftLimiter = rateLimit({ windowMs: 60_000, limit: 6, standardHeaders: "draft-7", legacyHeaders: false });
app.post("/api/candidates/:id/draft", ...write, draftLimiter, safe(async (req, res) => {
  const candidate = await prisma.candidate.findUnique({ where: { id: req.params.id } });
  if (!candidate) return res.status(404).json({ error: "Candidate not found" });
  const eligibility = outreachDecision(candidate);
  if (!eligibility.canDraft) return res.status(409).json({ error: "Candidate not draft-ready", stage: eligibility.stage, blockers: eligibility.blockers });
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
app.get("/api/drafts", candidateReadScope, safe(async (req, res) => {
  const drafts = await prisma.outreachDraft.findMany({
    // Guard against a draft accidentally referencing a candidate from a
    // different workspace, even if legacy data was inconsistently migrated.
    where: { workspaceId: req.candidateScope,
      candidate: { workspaceId: req.candidateScope } },
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
  // No automatic spending without an explicitly enabled server feature and
  // a persisted per-campaign approval. The loop is not an always-on SLA on
  // Render free or while the service is sleeping.
  const stopGroundingWorker = env.AI_GROUNDING_RESOLUTION_ENABLED === "true"
    ? startGroundingResolutionWorker(prisma) : () => {};
  const stopEmailTriageWorker = env.AI_EMAIL_TRIAGE_ENABLED === "true"
    ? startEmailTriageWorker(prisma) : () => {};
  const stopApprovedWorker = env.AI_AGENT_AUTORUN_ENABLED === "true" &&
    env.AI_AGENT_RESEARCH_ENABLED === "true" &&
    env.AI_AGENT_EXECUTOR_ENABLED === "true"
    ? startApprovedCampaignWorker(prisma, { encryptionKey: env.AI_ENCRYPTION_KEY })
    : () => {};
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopApprovedWorker();
    stopGroundingWorker();
    stopEmailTriageWorker();
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
