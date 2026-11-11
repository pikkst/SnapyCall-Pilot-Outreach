import { createHash } from "node:crypto";

const MAX_FEED_BYTES = 250_000;
const MAX_ROBOTS_BYTES = 100_000;
const MAX_ITEMS = 40;
export const DISCOVERY_AGENT = "SnapyCallPilotDiscovery";

export function parseApprovedSources(value) {
  if (!value?.trim()) return [];
  const urls = value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
  if (urls.length > 20) throw new Error("Too many configured discovery feeds");
  const result = urls.map((value) => {
    let url;
    try { url = new URL(value); } catch { throw new Error("Invalid configured discovery feed"); }
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !url.hostname.includes(".") || !/^[a-z0-9.-]+$/i.test(url.hostname) ||
      url.hostname === "localhost" || url.hostname.endsWith(".local") ||
      url.hostname.endsWith(".internal") || /(?:^|\.)linkedin\.com$/.test(url.hostname) ||
      /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname.includes("..") ||
      url.pathname.length > 500 || url.search.length > 500) {
      throw new Error("Configured discovery feeds must use public HTTPS domains (LinkedIn is excluded)");
    }
    url.hash = "";
    return url.toString();
  });
  return [...new Set(result)];
}

export function discoveryKeyFor(feedUrl, author) {
  return createHash("sha256").update("rss:" + feedUrl + ":" + author.trim().toLocaleLowerCase("en")).digest("hex");
}

function decodeXml(value) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => {
      const num = n.toLowerCase().startsWith("x") ? parseInt(n.slice(1), 16) : Number(n);
      return num >= 32 && num <= 0x10ffff && !(num >= 0xd800 && num <= 0xdfff) ? String.fromCodePoint(num) : "";
    })
    .replace(/&(amp|lt|gt|quot|apos);/gi, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[e.toLowerCase()])
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ").trim();
}

function tag(block, name) {
  const escaped = name.replace(/[.*+?^$\{\}()|[\]\\]/g, "\\$&");
  return block.match(new RegExp("<" + escaped + "(?:\\s[^>]*)?>([\\s\\S]*?)<\\/" + escaped + "\\s*>", "i"))?.[1] ?? "";
}
function atomHref(block) {
  const links = [...block.matchAll(/<link\b([^>]*)\/?\s*>/gi)];
  for (const [, attrs] of links) {
    const rel = attrs.match(/\brel\s*=\s*["']([^"']+)["']/i)?.[1] ?? "alternate";
    if (rel !== "alternate") continue;
    const href = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if (href) return decodeXml(href);
  }
  return "";
}
export function parseSyndication(xml, feedUrl) {
  if (typeof xml !== "string" || xml.length > MAX_FEED_BYTES || /<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new Error("Unsafe or oversized feed");
  }
  const atom = /<feed\b/i.test(xml);
  const sections = [...xml.matchAll(atom ? /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry\s*>/gi : /<item(?:\s[^>]*)?>([\s\S]*?)<\/item\s*>/gi)];
  if (!sections.length && !/<rss\b|<feed\b|<rdf:RDF\b/i.test(xml)) throw new Error("Unsupported feed format");
  const result = [];
  const seen = new Set();
  for (const [, block] of sections.slice(0, MAX_ITEMS)) {
    const rawAuthor = atom ? tag(tag(block, "author"), "name") : (tag(block, "dc:creator") || tag(block, "author"));
    const author = decodeXml(rawAuthor).slice(0, 160);
    const title = decodeXml(tag(block, "title")).slice(0, 240);
    const link = atom ? atomHref(block) : decodeXml(tag(block, "link"));
    if (!author || !title || !link) continue;
    let url;
    try { url = new URL(link, feedUrl); } catch { continue; }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || !url.hostname.includes(".")) continue;
    // The feed claims authorship; this is not proof of a professional identity.
    // Do not infer personal email addresses or online language eligibility.
    const key = discoveryKeyFor(feedUrl, author);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(Object.freeze({ discoveryKey: key, name: author, headline: title, sourceUrl: url.toString(), feedUrl }));
  }
  return result;
}

function robotsPattern(pattern) {
  const escaped = pattern.replace(/[.*+?^$\{\}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*");
  return new RegExp("^" + escaped.replace(/\\\$$/, "$"));
}
export function robotsAllowed(robots, path, agent = DISCOVERY_AGENT) {
  if (typeof robots !== "string") return false;
  const groups = [];
  let agents = [], rules = [];
  function flush() { if (agents.length) groups.push({ agents, rules }); agents = []; rules = []; }
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.split("#")[0].trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase(), value = line.slice(idx + 1).trim();
    if (field === "user-agent") {
      if (rules.length) flush();
      agents.push(value.toLowerCase());
    } else if ((field === "allow" || field === "disallow") && agents.length && value) {
      rules.push({ allow: field === "allow", pattern: value });
    }
  }
  flush();
  const applicable = groups.filter((group) => group.agents.includes(agent.toLowerCase()));
  const wildcard = groups.filter((group) => group.agents.includes("*"));
  const selected = applicable.length ? applicable : wildcard;
  const matches = selected.flatMap((group) => group.rules)
    .filter((rule) => robotsPattern(rule.pattern).test(path))
    .sort((a, b) => b.pattern.length - a.pattern.length || Number(b.allow) - Number(a.allow));
  return matches[0]?.allow ?? (matches.length === 0);
}

async function limitedText(response, maxBytes) {
  if (!response.ok) throw new Error("Source responded with HTTP " + response.status);
  const type = response.headers.get("content-type") ?? "";
  if (!/xml|rss|atom|text\//i.test(type)) throw new Error("Source did not return an XML/text feed");
  if (Number(response.headers.get("content-length")) > maxBytes) throw new Error("Source body too large");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty source response");
  let length = 0, parts = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new Error("Source body too large");
      parts.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts.map((p) => Buffer.from(p))));
}

export async function discoverFeed({ url, approvedSources, fetcher = fetch }) {
  if (!approvedSources.includes(url)) throw new Error("Discovery source has not been approved");
  const parsed = new URL(url);
  const robotsUrl = parsed.origin + "/robots.txt";
  const options = { redirect: "manual", signal: AbortSignal.timeout(8_000), headers: { "user-agent": DISCOVERY_AGENT } };
  const robotsResponse = await fetcher(robotsUrl, options);
  if (robotsResponse.status !== 404 && robotsResponse.status !== 410) {
    const robots = await limitedText(robotsResponse, MAX_ROBOTS_BYTES);
    if (!robotsAllowed(robots, parsed.pathname + parsed.search)) throw new Error("Source disallows automated access");
  }
  const response = await fetcher(url, options);
  const xml = await limitedText(response, MAX_FEED_BYTES);
  return parseSyndication(xml, url);
}
