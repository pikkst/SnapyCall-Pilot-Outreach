// Optional ZeroBounce v2 adapter. Never called by the application unless a
// separately approved server-only feature enables mailbox verification.
// The EU endpoint and POST body avoid exposing API keys/emails in the URL.
// See https://www.zerobounce.net/docs/email-validation-api-quickstart/v2-validate-emails
import { normalizeVerificationAddress } from "./email-deliverability.js";

const ENDPOINT = "https://api-eu.zerobounce.net/v2/validate";
const DANGEROUS = new Set([
  "role_based", "role_based_catch_all", "role_based_accept_all", "disposable",
  "toxic", "possible_trap", "accept_all", "ai_agent_mailbox",
  "global_suppression", "blocked",
]);

export function mapZeroBounceResult(body, requestedEmail) {
  const expected = normalizeVerificationAddress(requestedEmail);
  const actual = normalizeVerificationAddress(body?.address);
  // A vendor error, unexpected response, or wrong mailbox MUST NOT be VALID.
  if (!expected || !actual || actual.email !== expected.email ||
      typeof body?.status !== "string") {
    throw new TypeError("ZeroBounce response did not match requested address");
  }
  const subStatus = typeof body.sub_status === "string" ?
    body.sub_status.toLowerCase() : "";
  const status = body.status.toLowerCase();
  const isDangerous = DANGEROUS.has(subStatus);
  const catchAll = body.catchall_domain !== false ||
    status === "catch-all" || subStatus.includes("catch_all") ||
    subStatus === "accept_all" || subStatus === "role_based_accept_all";
  const roleAccount = isDangerous || status === "abuse" || status === "spamtrap" ||
    status === "do_not_mail";
  const disposable = subStatus === "disposable";
  const verdict = status === "valid" && !catchAll && !roleAccount && !disposable
    ? "DELIVERABLE"
    : status === "invalid" ? "UNDELIVERABLE"
      : status === "unknown" ? "UNKNOWN" : "RISKY";
  return Object.freeze({
    provider: "ZEROBOUNCE", adapterVersion: "v1",
    email: expected.email, verdict, evidenceType: "MAILBOX_REACHABILITY",
    catchAll, disposable, roleAccount,
  });
}

export function createZeroBounceEuAdapter({ apiKey, fetchFn = fetch } = {}) {
  if (typeof apiKey !== "string" || apiKey.length < 8 ||
      typeof fetchFn !== "function") {
    throw new TypeError("Server-side ZeroBounce credentials required");
  }
  return Object.freeze({
    provider: "ZEROBOUNCE",
    version: "v1",
    async verify(email, { signal } = {}) {
      const parsed = normalizeVerificationAddress(email);
      if (!parsed || !signal || typeof signal.aborted !== "boolean") {
        throw new TypeError("Verified email and abort signal required");
      }
      // No IP address, gender, lookup enrichment, or additional personal data.
      const params = new URLSearchParams({
        api_key: apiKey, email: parsed.email, timeout: "10",
      });
      const response = await fetchFn(ENDPOINT, {
        method: "POST", redirect: "error", signal,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: params.toString(),
      });
      if (!response?.ok) throw new Error("ZEROBOUNCE_UNAVAILABLE");
      const text = await response.text();
      if (typeof text !== "string" || text.length > 8192) {
        throw new Error("ZEROBOUNCE_UNEXPECTED_RESULT");
      }
      let payload;
      try { payload = JSON.parse(text); }
      catch { throw new Error("ZEROBOUNCE_UNEXPECTED_RESULT"); }
      // Never forward provider payload: may contain names, locations, or keys.
      return mapZeroBounceResult(payload, parsed.email);
    },
  });
}
