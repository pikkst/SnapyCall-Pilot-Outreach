import { createHash } from "node:crypto";

const PROVIDER_URL = "https://api.resend.com/emails";
const RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
const LEASE_MS = 2 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const STALE_MS = 5 * 60 * 1000;

function mailbox(value) {
  if (typeof value !== "string" || value.length > 254 || /[\r\n]/.test(value)) return false;
  const address = value.trim().replace(/^.*<([^<>]+)>$/, "$1");
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address);
}

export function reconciliationEmailConfig(env = process.env) {
  if (env.RESEARCH_ALERT_DELIVERY_ENABLED !== "true") return null;
  const { RESEND_API_KEY: apiKey, RESEARCH_ALERT_FROM: from,
    RESEARCH_ALERT_TO: to } = env;
  if (!apiKey || !mailbox(from) || !mailbox(to)) {
    throw new Error("RESEARCH_ALERT_DELIVERY_NOT_CONFIGURED");
  }
  return { apiKey, from, to };
}

export function makeReconciliationEmail(config, incident) {
  if (!/^[a-f0-9]{64}$/.test(incident.dedupeKey) ||
      !Number.isSafeInteger(incident.staleCount) || incident.staleCount < 1 ||
      !Number.isSafeInteger(incident.estimatedHeldCents) ||
      incident.estimatedHeldCents < 1) {
    throw new TypeError("Invalid operational alert");
  }
  const text = [
    "SnapyCall Pilot Outreach — Research charge reconciliation required",
    "",
    "Unresolved reservation count at first detection: " + incident.staleCount,
    "Estimated application-held amount: USD " +
      (incident.estimatedHeldCents / 100).toFixed(2),
    "Incident reference: " + incident.dedupeKey.slice(0, 12),
    "",
    "This is internal application accounting, NOT a provider invoice.",
    "Inspect the authenticated admin diagnostic panel and provider evidence.",
    "No funds were automatically released or reconciled.",
  ].join("\n");
  return {
    from: config.from, to: [config.to],
    subject: "SnapyCall: manual research charge review required",
    text,
  };
}

export async function sendReconciliationEmail(config, item, fetcher = fetch) {
  const response = await fetcher(PROVIDER_URL, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
    headers: {
      authorization: "Bearer " + config.apiKey,
      "content-type": "application/json",
      "Idempotency-Key": "snapycall-research-reconcile-" + item.dedupeKey,
    },
    body: JSON.stringify(makeReconciliationEmail(config, item)),
  });
  if (!response.ok) throw new Error("ALERT_PROVIDER_REJECTED");
  const body = await response.json();
  if (typeof body?.id !== "string" || !body.id) throw new Error("ALERT_PROVIDER_INVALID_RESPONSE");
  return body.id;
}

function incidentKey(id) {
  return createHash("sha256").update("research-stale-v1:" + id).digest("hex");
}

// Explicit operator invocation only. There is deliberately no app startup
// timer, cron route, background worker, or access to outreach draft sending.
export async function dispatchResearchReconciliationAlert(db,
  env = process.env, fetcher = fetch, now = new Date()) {
  const config = reconciliationEmailConfig(env);
  if (!config) return { state: "disabled" };
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("Invalid alert clock");
  }
  const item = await db.researchReconciliationOutbox.findFirst({
    where: { OR: [
      { status: { in: ["PENDING", "FAILED"] } },
      { status: "SENDING", leaseUntil: { lte: now } },
    ] },
    orderBy: { firstDetectedAt: "asc" },
  });
  if (!item) return { state: "empty" };
  const where = {
    dedupeKey: item.dedupeKey, status: item.status,
    attemptAt: item.attemptAt, leaseUntil: item.leaseUntil,
    attempts: item.attempts,
  };
  const oldest = await db.researchSpendReservation.findFirst({
    where: { status: "RESERVED", createdAt: { lte: new Date(now.getTime() - STALE_MS) } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  if (!oldest || incidentKey(oldest.id) !== item.dedupeKey) {
    const closed = await db.researchReconciliationOutbox.updateMany({
      where: { ...where,
        ...(item.status === "SENDING" ? { leaseUntil: { lte: now } } : {}),
      },
      data: { status: "SKIPPED", leaseUntil: null,
        errorCode: "INCIDENT_NO_LONGER_OLDEST" },
    });
    return { state: closed.count === 1 ? "skipped" : "claimed_elsewhere" };
  }
  if (item.attempts >= MAX_ATTEMPTS ||
      (item.attemptAt && now.getTime() - item.attemptAt.getTime() >= RETRY_WINDOW_MS)) {
    const closed = await db.researchReconciliationOutbox.updateMany({
      where: { ...where,
        ...(item.status === "SENDING" ? { leaseUntil: { lte: now } } : {}),
      },
      data: { status: "MANUAL_REVIEW", leaseUntil: null,
        errorCode: "RETRY_SAFETY_WINDOW_EXCEEDED" },
    });
    return { state: closed.count === 1 ? "manual_review" : "claimed_elsewhere" };
  }
  const leaseUntil = new Date(now.getTime() + LEASE_MS);
  const claimed = await db.researchReconciliationOutbox.updateMany({
    where: { ...where,
      ...(item.status === "SENDING" ? { leaseUntil: { lte: now } } : {}),
    },
    data: { status: "SENDING", leaseUntil,
      attemptAt: item.attemptAt ?? now, attempts: { increment: 1 },
      errorCode: null },
  });
  if (claimed.count !== 1) return { state: "claimed_elsewhere" };

  // Last read before the network call. This is a best-effort safety check,
  // not an atomic provider/DB transaction.
  const latest = await db.researchSpendReservation.findFirst({
    where: { status: "RESERVED", createdAt: { lte: new Date(now.getTime() - STALE_MS) } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  if (!latest || incidentKey(latest.id) !== item.dedupeKey) {
    await db.researchReconciliationOutbox.updateMany({
      where: { dedupeKey: item.dedupeKey, status: "SENDING", leaseUntil },
      data: { status: "SKIPPED", leaseUntil: null,
        errorCode: "INCIDENT_CLEARED_BEFORE_SEND" },
    });
    return { state: "skipped" };
  }

  let providerId = null;
  try {
    providerId = await sendReconciliationEmail(config, item, fetcher);
  } catch {
    // Unknown network outcomes may already have been accepted by Resend.
    // Reuse the original provider idempotency key only inside its 24h window.
    const updated = await db.researchReconciliationOutbox.updateMany({
      where: { dedupeKey: item.dedupeKey, status: "SENDING", leaseUntil },
      data: { status: "FAILED", leaseUntil: null, errorCode: "DELIVERY_UNCERTAIN" },
    });
    return { state: updated.count === 1 ? "failed" : "claimed_elsewhere" };
  }
  const updated = await db.researchReconciliationOutbox.updateMany({
    where: { dedupeKey: item.dedupeKey, status: "SENDING", leaseUntil },
    data: { status: "SENT", leaseUntil: null, sentAt: now,
      providerId, errorCode: null },
  });
  return { state: updated.count === 1 ? "sent" : "claimed_elsewhere" };
}
