// Mailbox-verification provider boundary. No service endpoint or credentials
// are configured here; this module does not perform network requests itself.
// A provider must be explicitly approved before a server-only adapter is wired.
import { normalizeVerificationAddress } from "./email-deliverability.js";

const PROVIDER_CODES = new Set(["ABSTRACT", "EMAILABLE", "NEVERBOUNCE", "ZEROBOUNCE"]);
const VERDICTS = new Set(["DELIVERABLE", "UNDELIVERABLE", "RISKY", "UNKNOWN"]);
const EVIDENCE_TYPES = new Set(["MAILBOX_REACHABILITY", "PROVIDER_ACCEPTANCE"]);

export class MailboxVerificationContractError extends Error {
  constructor(code) {
    super("Mailbox verification contract rejected");
    this.name = "MailboxVerificationContractError";
    this.code = code;
  }
}

// Requires a provider-specific adapter that independently normalizes its
// official response schema. In particular, no generic SMTP '250' response,
// catch-all result, or DNS MX check can produce a verified inbox.
export function normalizeMailboxProviderEvidence(raw, {
  email, provider, adapterVersion,
} = {}) {
  const expected = normalizeVerificationAddress(email);
  const observed = normalizeVerificationAddress(raw?.email);
  if (!expected || !observed || expected.email !== observed.email) {
    throw new MailboxVerificationContractError("EMAIL_MISMATCH");
  }
  if (!PROVIDER_CODES.has(provider) ||
      typeof adapterVersion !== "string" ||
      !/^v[1-9][0-9]{0,2}$/.test(adapterVersion) ||
      raw?.provider !== provider || raw?.adapterVersion !== adapterVersion) {
    throw new MailboxVerificationContractError("PROVIDER_NOT_TRUSTED");
  }
  if (!VERDICTS.has(raw?.verdict) || !EVIDENCE_TYPES.has(raw?.evidenceType) ||
      typeof raw?.catchAll !== "boolean" ||
      typeof raw?.disposable !== "boolean" ||
      typeof raw?.roleAccount !== "boolean") {
    throw new MailboxVerificationContractError("UNRECOGNIZED_PROVIDER_RESPONSE");
  }
  if (raw.verdict === "DELIVERABLE" &&
      (raw.catchAll || raw.disposable || raw.roleAccount ||
        raw.evidenceType !== "MAILBOX_REACHABILITY")) {
    return Object.freeze({ status: "RISKY", reason: "AMBIGUOUS_MAILBOX",
      provider, adapterVersion, emailNormalized: expected.email });
  }
  const status = raw.verdict === "DELIVERABLE" ? "VALID" :
    raw.verdict === "UNDELIVERABLE" ? "INVALID" :
    raw.verdict === "RISKY" ? "RISKY" : "UNKNOWN";
  return Object.freeze({
    status,
    reason: status === "VALID" ? "PROVIDER_MAILBOX_REACHABLE" :
      status === "INVALID" ? "PROVIDER_MAILBOX_UNREACHABLE" :
      status === "RISKY" ? "PROVIDER_RISKY" : "PROVIDER_UNKNOWN",
    provider, adapterVersion, emailNormalized: expected.email,
  });
}

// This is an opt-in, single-address invocation contract, NOT a scheduler.
// The adapter is server-owned and receives AbortSignal to bound network time.
// Failed/uncertain provider calls never trigger an automatic retry.
export async function verifyMailboxWithApprovedAdapter(email, {
  adapter, approved = false, now = () => new Date(),
  timeoutMs = 8000,
} = {}) {
  const normalized = normalizeVerificationAddress(email);
  if (!normalized) throw new MailboxVerificationContractError("INVALID_EMAIL");
  if (approved !== true || !adapter ||
      !PROVIDER_CODES.has(adapter.provider) ||
      typeof adapter.version !== "string" ||
      !/^v[1-9][0-9]{0,2}$/.test(adapter.version) ||
      typeof adapter.verify !== "function") {
    throw new MailboxVerificationContractError("PROVIDER_DISABLED");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000 ||
      typeof now !== "function") {
    throw new TypeError("Invalid verification settings");
  }
  const startedAt = now();
  if (!(startedAt instanceof Date) || !Number.isFinite(startedAt.getTime())) {
    throw new TypeError("Invalid verification timestamp");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let raw;
  try {
    raw = await adapter.verify(normalized.email, { signal: controller.signal });
    if (controller.signal.aborted) throw new Error("PROVIDER_TIMEOUT");
  } catch {
    // Provider might have charged before a timeout; no silent retry or
    // conversion of an uncertain result into VALID.
    return Object.freeze({ status: "UNKNOWN", reason: "PROVIDER_UNAVAILABLE",
      provider: adapter.provider, adapterVersion: adapter.version,
      emailNormalized: normalized.email, checkedAt: startedAt,
      billableAttemptUncertain: true });
  } finally { clearTimeout(timer); }
  const evidence = normalizeMailboxProviderEvidence(raw, {
    email: normalized.email, provider: adapter.provider,
    adapterVersion: adapter.version,
  });
  return Object.freeze({ ...evidence, checkedAt: startedAt,
    billableAttemptUncertain: false });
}
