// Read-only, bounded HTTPS retrieval of provider-cited public pages.
// This adapter never executes scripts, follows redirects or accesses private IPs.
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { publicCitationUrl } from "./research-evidence.js";

// The prior 64 KiB cap rejected legitimate public biography pages. Keep an
// explicit, finite limit (128 KiB) for both declared and streamed bodies.
// No redirects, scripts, robots bypass or private-network fetches are enabled.
const MAX_BYTES = 128 * 1024;
const TIMEOUT_MS = 4000;
const USER_AGENT = "SnapyCallResearchPreview/1.0 (+https://pilot.eventnexus.eu)";

export function isPublicIpv4(address) {
  if (isIP(address) !== 4) return false; // Fail closed on IPv6 until global-range support.
  const [a, b, c] = address.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      // IANA special-purpose blocks are excluded even if some addresses
    // are globally reachable; public page inspection must fail closed.
    (a === 192 && (b === 168 || b === 0 ||
        (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) ||
      (a === 203 && b === 0 && c === 113)) return false;
  return true;
}

export async function resolvePublicAddress(host, resolve = dnsLookup) {
  // DNS rebinding is prevented by pinning a validated IP in HTTPS's lookup.
  const records = await resolve(host, { all: true, verbatim: true });
  if (!Array.isArray(records) || records.length < 1 || records.length > 16 ||
      records.some(r => typeof r?.address !== "string" ||
        (isIP(r.address) !== 4 && isIP(r.address) !== 6) ||
        (isIP(r.address) === 4 && !isPublicIpv4(r.address)) ||
        (r.family !== undefined && r.family !== isIP(r.address)))) {
    throw new Error("PUBLIC_PAGE_DNS_REJECTED");
  }
  // Dual-stack public sites are supported by pinning a validated IPv4 record.
  // IPv6-only sites fail closed until complete IPv6 egress classification exists.
  const ipv4 = records.find(r => isIP(r.address) === 4);
  if (!ipv4) throw new Error("PUBLIC_PAGE_NO_VALID_IPV4");
  return ipv4.address;
}

function pinnedHttps(url, address, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    const req = httpsRequest(url, {
      method: "GET", timeout: timeoutMs,
      // A wall-clock deadline also bounds slow-trickle responses.
      signal: AbortSignal.timeout(timeoutMs),
      agent: false, maxRedirects: 0,
      headers: { "user-agent": USER_AGENT, accept: "text/html,text/plain;q=0.9,*/*;q=0.1",
        "accept-encoding": "identity", connection: "close" },
      lookup: (_hostname, options, cb) => {
        // Node's autoSelectFamily path requests lookup({ all: true }).
        // Preserve DNS pinning in both lookup callback contracts.
        if (options?.all) cb(null, [{ address, family: 4 }]);
        else cb(null, address, 4);
      },
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400) {
        response.resume();
        reject(new Error("PUBLIC_PAGE_REDIRECT_REJECTED")); return;
      }
      const status = response.statusCode;
      if (status !== 200 && status !== 404) {
        response.resume(); reject(new Error("PUBLIC_PAGE_HTTP_REJECTED")); return;
      }
      const declared = Number(response.headers["content-length"]);
      if (Number.isFinite(declared) && declared > MAX_BYTES) {
        response.destroy(); reject(new Error("PUBLIC_PAGE_TOO_LARGE")); return;
      }
      response.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) {
          response.destroy(new Error("PUBLIC_PAGE_TOO_LARGE")); return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({
        status, contentType: response.headers["content-type"] ?? "",
        contentEncoding: response.headers["content-encoding"] ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      }));
      response.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("PUBLIC_PAGE_TIMEOUT")));
    req.on("error", reject);
    req.end();
  });
}

// Robots exclusion is deliberately conservative: missing robots.txt (404)
// allows public content, while network/parse errors and unavailable policy block.
export function robotsAllows(text, pathname) {
  if (typeof text !== "string" || text.length > MAX_BYTES ||
      typeof pathname !== "string" || !pathname.startsWith("/")) return false;
  const groups = [];
  let agents = [], rules = [], hadRule = false;
  function flush() {
    if (agents.length) groups.push({ agents, rules });
    agents = []; rules = []; hadRule = false;
  }
  for (const original of text.split(/\r?\n/)) {
    const line = original.split("#", 1)[0].trim();
    if (!line) continue;
    const match = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!match) continue;
    const directive = match[1].toLowerCase();
    const value = match[2].trim();
    // Unsupported robots pattern operators cannot be interpreted safely.
    if ((directive === "disallow" || directive === "allow") && /[*$]/.test(value)) {
      return false;
    }
    if (directive === "user-agent") {
      if (hadRule) flush();
      agents.push(value.toLowerCase());
    } else if ((directive === "disallow" || directive === "allow") && agents.length) {
      hadRule = true;
      rules.push({ directive, value });
    }
  }
  flush();
  const matches = groups.filter(g => g.agents.includes("snapycallresearchpreview"));
  const selected = matches.length ? matches : groups.filter(g => g.agents.includes("*"));
  const applicable = selected.flatMap(g => g.rules)
    .filter(r => r.value && pathname.startsWith(r.value));
  applicable.sort((a, b) => b.value.length - a.value.length ||
    (a.directive === "allow" ? -1 : 1));
  return !applicable.length || applicable[0].directive === "allow";
}

function htmlText(input) {
  const cleaned = input.replace(/<(?:script|style|noscript)\b[^>]*>[\s\S]*?<\/\s*(?:script|style|noscript)\s*>/gi, " ");
  // A sole literal H1 is a semantic person-name label, not a guessed
  // identity. Multiple H1 headings or complex markup cannot be promoted.
  // Actual person equality and uniquely attributed email remain downstream.
  const soleHeading = [...cleaned.matchAll(/<h1\b/gi)].length === 1;
  const labeled = soleHeading
    ? cleaned.replace(/<h1\b[^>]*>([^<>]{5,160})<\/h1\s*>/gi,
      (_whole, title) => " Name: " + title + " ")
    : cleaned;
  return labeled
    // Convert only a visible, explicitly named mailto anchor into text.
    // The visible text must either say Email/E-mail or display the *exact*
    // linked mailbox. Generic links, hidden scripts and mismatched labels
    // are never promoted. The named-person verifier still gates acceptance.
    .replace(/<a\b[^>]*\s+href\s*=\s*(["'])mailto:([a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9.-]{1,190}\.[a-z]{2,24})\1[^>]*>([^<>]{1,254})<\/a\s*>/gi,
      (match, _quote, address, label) =>
        /^(?:e-?mail)$/i.test(label.trim()) ||
        label.trim().toLowerCase() === address.toLowerCase()
          ? " Email: " + address + " " : match)
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:nbsp|#160);/gi, " ")
    .replace(/&(?:amp|#38);/gi, "&")
    .replace(/&(?:#64|commat);/gi, "@")
    .replace(/\s+/g, " ").trim();
}

export async function retrieveCitedPublicPage(url, {
  resolve = dnsLookup, request = pinnedHttps,
} = {}) {
  const canonical = publicCitationUrl(url);
  if (!canonical) throw new Error("PUBLIC_PAGE_URL_REJECTED");
  const parsed = new URL(canonical);
  const robots = new URL("/robots.txt", parsed);
  const robotsAddress = await resolvePublicAddress(parsed.hostname, resolve);
  const policy = await request(robots, robotsAddress);
  if (policy.status !== 404 && (policy.status !== 200 ||
      !/^text\/plain(?:;|$)/i.test(policy.contentType) ||
      policy.contentEncoding || !robotsAllows(policy.body, parsed.pathname))) {
    throw new Error("PUBLIC_PAGE_ROBOTS_REJECTED");
  }
  // Re-resolve and revalidate for the document request, then pin again.
  const pageAddress = await resolvePublicAddress(parsed.hostname, resolve);
  const page = await request(parsed, pageAddress);
  if (page.status !== 200 || page.contentEncoding ||
      !/^(text\/html|text\/plain)(?:;|$)/i.test(page.contentType) ||
      /charset\s*=\s*(?!utf-8)([^;]+)/i.test(page.contentType)) {
    throw new Error("PUBLIC_PAGE_CONTENT_REJECTED");
  }
  if (typeof page.body !== "string" || Buffer.byteLength(page.body, "utf8") > MAX_BYTES) {
    throw new Error("PUBLIC_PAGE_TOO_LARGE");
  }
  return { url: canonical, text: htmlText(page.body) };
}
