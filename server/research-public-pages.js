// Read-only, bounded HTTPS retrieval of provider-cited public pages.
// This adapter never executes scripts or accesses private IPs. It may follow
// exactly one revalidated HTTPS canonical redirect on the same site.
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { publicCitationUrl } from "./research-evidence.js";
import { explicitJsonLdPersonEmail } from "./research-structured-person-evidence.js";

// The prior 64 KiB cap rejected legitimate public biography pages. Keep an
// explicit, finite limit (128 KiB) for both declared and streamed bodies.
// No cross-site redirects, scripts, robots bypass or private-network fetches.
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
        // Do not let the transport follow a Location header. The caller
        // must validate the target, its robots policy and pinned DNS afresh.
        const location = response.headers.location;
        response.resume();
        resolve({
          status: response.statusCode,
          location: typeof location === "string" ? location : null,
        });
        return;
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

// Follow RFC 9309's longest-match rule (including '*' and terminal '$').
// Rules for other agents never block this crawler. Unknown directives are
// ignored. Robots retrieval/authorization remains in the HTTPS reader.
function robotsPatternMatch(value, path) {
  if (!value || !value.startsWith("/") || value.length > 2048 ||
      /[\r\n\x00-\x1f]/.test(value) ||
      (value.includes("$") && !value.endsWith("$"))) return null;
  const anchored = value.endsWith("$");
  const pattern = anchored ? value.slice(0, -1) : value;
  const parts = pattern.split("*");
  // Deterministic substring matching avoids regex backtracking for untrusted
  // policy patterns. Wildcards may match zero or more URI characters.
  let at = parts[0].length;
  if (!path.startsWith(parts[0])) {
    return { matches: false, specificity: pattern.length - parts.length + 1 };
  }
  for (let i = 1; i < parts.length; i++) {
    const fragment = parts[i];
    if (i === parts.length - 1 && anchored) {
      if (!path.endsWith(fragment) ||
          path.length - fragment.length < at) {
        return { matches: false,
          specificity: pattern.length - parts.length + 1 };
      }
      at = path.length;
    } else {
      const next = path.indexOf(fragment, at);
      if (next < 0) {
        return { matches: false,
          specificity: pattern.length - parts.length + 1 };
      }
      at = next + fragment.length;
    }
  }
  return {
    matches: !anchored || at === path.length,
    specificity: pattern.length - parts.length + 1,
  };
}

export function robotsAllows(text, pathname) {
  if (typeof text !== "string" ||
      Buffer.byteLength(text, "utf8") > MAX_BYTES ||
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
    if (directive === "user-agent") {
      if (hadRule) flush();
      agents.push(value.toLowerCase());
    } else if ((directive === "disallow" || directive === "allow") &&
        agents.length) {
      hadRule = true;
      if (value) rules.push({ directive, value });
    }
  }
  flush();
  const matches = groups.filter(group =>
    group.agents.includes("snapycallresearchpreview"));
  const selected = matches.length ? matches : groups.filter(group =>
    group.agents.includes("*"));
  let best = null;
  for (const rule of selected.flatMap(group => group.rules)) {
    const result = robotsPatternMatch(rule.value, pathname);
    // Malformed applicable rules must not silently become an allow.
    if (!result) return false;
    if (!result.matches) continue;
    if (!best || result.specificity > best.specificity ||
        (result.specificity === best.specificity &&
          rule.directive === "allow")) {
      best = { directive: rule.directive, specificity: result.specificity };
    }
  }
  return !best || best.directive === "allow";
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

// Extract at most one *explicitly linked* public contact document from a
// retrieved profile. This is not a crawler: scripts, arbitrary links, query
// parameters, external hosts and ambiguous contact links are never followed.
// The target must pass its own DNS/robots/content checks on retrieval.
export function linkedPublicContactUrl(sourceUrl, html) {
  const source = publicCitationUrl(sourceUrl);
  if (!source || typeof html !== "string" ||
      Buffer.byteLength(html, "utf8") > MAX_BYTES) return null;
  const withoutScripts = html.replace(/<!--[\s\S]*?-->/g, " ")
    .replace(
      /<(?:script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\s*(?:script|style|noscript|template)\s*>/gi,
      " ");
  const found = new Set();
  const anchors = withoutScripts.matchAll(
    /<a\b[^>]{0,1024}\shref\s*=\s*(["'])([^"'<>]{1,2048})\1[^>]*>([^<>]{1,80})<\/a\s*>/gi);
  for (const match of anchors) {
    if (/\s(?:hidden|aria-hidden\s*=\s*["\x27]?true)\b/i.test(match[0]) ||
        !/^(?:contact|contact me|contact us|get in touch)$/i.test(match[3].trim())) continue;
    let resolved;
    try { resolved = new URL(match[2], source); }
    catch { continue; }
    const allowed = publicCitationUrl(resolved.href);
    if (!allowed || resolved.hostname !== new URL(source).hostname ||
        resolved.search || resolved.username || resolved.password ||
        !/\/(?:contact|contact-me|get-in-touch)\/?$/i.test(resolved.pathname) ||
        allowed === source) continue;
    found.add(allowed);
    if (found.size > 1) return null;
  }
  return found.size === 1 ? [...found][0] : null;
}

// HTTP media-type parameters may legally quote UTF-8 (RFC 9110).
// Accept only the already-supported text content types and UTF-8 charset.
// Never sniff application/octet-stream, HTML disguised as JSON, or encoded
// responses. Reject duplicated/malformed charset rather than guessing.
export function supportedPublicTextMediaType(value) {
  if (typeof value !== "string" || value.length > 256) return null;
  const parts = value.split(";");
  const type = parts.shift().trim().toLowerCase();
  if (type !== "text/html" && type !== "text/plain") return null;
  let charsetSeen = false;
  for (const param of parts) {
    const trimmed = param.trim();
    if (/^charset\b/i.test(trimmed)) {
      const found = /^charset\s*=\s*(?:"([^"]+)"|([a-z0-9._-]+))$/i.exec(trimmed);
      if (!found || charsetSeen ||
          (found[1] ?? found[2]).toLowerCase() !== "utf-8") return null;
      charsetSeen = true;
    }
  }
  return type;
}

// Redirects are source hints, not fetch permission. Only a single canonical
// HTTPS redirect between the exact host and its www/apex variant is permitted.
// Both source and destination independently require safe DNS and robots
// authorization. The original provider-cited URL remains the auditable
// citation: it resolves directly to the inspected document.
export function canonicalPublicProfileRedirect(original, location) {
  const start = publicCitationUrl(original);
  if (!start || typeof location !== "string" ||
      location.length < 1 || location.length > 2048) return null;
  let absolute;
  try { absolute = new URL(location, start).href; }
  catch { return null; }
  const target = publicCitationUrl(absolute);
  if (!target || target === start) return null;
  const first = new URL(start);
  const last = new URL(target);
  const baseHost = host => host.startsWith("www.") ? host.slice(4) : host;
  if (baseHost(first.hostname) !== baseHost(last.hostname)) return null;
  return target;
}

export async function retrieveCitedPublicPage(url, {
  resolve = dnsLookup, request = pinnedHttps,
} = {}) {
  const canonical = publicCitationUrl(url);
  if (!canonical) throw new Error("PUBLIC_PAGE_URL_REJECTED");

  async function inspectOne(targetUrl) {
    const parsed = new URL(targetUrl);
    const robots = new URL("/robots.txt", parsed);
    const robotsAddress = await resolvePublicAddress(parsed.hostname, resolve);
    const policy = await request(robots, robotsAddress);
    if (policy.status !== 404 && (policy.status !== 200 ||
        supportedPublicTextMediaType(policy.contentType) !== "text/plain" ||
        policy.contentEncoding || !robotsAllows(policy.body, parsed.pathname + parsed.search))) {
      throw new Error("PUBLIC_PAGE_ROBOTS_REJECTED");
    }
    // Independently resolve before each document request to defend DNS
    // rebinding even when robots and the page share the same hostname.
    const pageAddress = await resolvePublicAddress(parsed.hostname, resolve);
    return request(parsed, pageAddress);
  }

  let target = canonical;
  let page = await inspectOne(target);
  if (page.status >= 300 && page.status < 400) {
    if (![301, 302, 307, 308].includes(page.status)) {
      throw new Error("PUBLIC_PAGE_REDIRECT_REJECTED");
    }
    const redirected = canonicalPublicProfileRedirect(target, page.location);
    if (!redirected) throw new Error("PUBLIC_PAGE_REDIRECT_REJECTED");
    target = redirected;
    page = await inspectOne(target);
  }
  // Never follow a second redirect. No arbitrary link discovery or
  // automatic cross-site navigation is authorized by this reader.
  if (page.status >= 300 && page.status < 400) {
    throw new Error("PUBLIC_PAGE_REDIRECT_REJECTED");
  }
  const mediaType = supportedPublicTextMediaType(page.contentType);
  if (page.status !== 200 || page.contentEncoding || !mediaType) {
    // Only a fixed, non-sensitive subtype; never log raw headers, URLs or
    // upstream status bodies. HTTP access rules stay fail-closed.
    const subtype = page.status !== 200 ? "status" :
      page.contentEncoding ? "encoding" : "mime";
    throw Object.assign(new Error("PUBLIC_PAGE_CONTENT_REJECTED"),
      { contentFailureSubtype: subtype });
  }
  if (typeof page.body !== "string" ||
      Buffer.byteLength(page.body, "utf8") > MAX_BYTES) {
    throw new Error("PUBLIC_PAGE_TOO_LARGE");
  }
  const linkedContact = mediaType === "text/html"
    ? linkedPublicContactUrl(canonical, page.body) : null;
  const structuredPerson = mediaType === "text/html"
    ? explicitJsonLdPersonEmail(page.body) : null;
  return {
    url: canonical, text: htmlText(page.body),
    ...(linkedContact ? { linkedContactUrl: linkedContact } : {}),
    ...(structuredPerson ? { structuredPerson } : {}),
  };
}
