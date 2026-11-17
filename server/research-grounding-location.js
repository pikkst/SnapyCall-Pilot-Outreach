// Resolve only Google-grounding redirect headers to unverified source hints.
// No destination fetch, person attribution, email inspection or provider call.
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { publicCitationUrl } from "./research-evidence.js";
import { resolvePublicAddress } from "./research-public-pages.js";

const GOOGLE_HOST = "vertexaisearch.cloud.google.com";
const PATH = /^\/grounding-api-redirect\/[A-Za-z0-9_=-]{8,1024}$/;
const TIMEOUT_MS = 4000;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

export function isGoogleGroundingCitation(value) {
  const canonical = publicCitationUrl(value);
  if (!canonical) return false;
  const url = new URL(canonical);
  return url.hostname === GOOGLE_HOST &&
    url.port === "" && url.search === "" && url.hash === "" &&
    PATH.test(url.pathname);
}

// This transport inspects exactly one response header. HTTPS certificate
// validation and hostname/SNI stay bound to Google's hostname. DNS resolution
// is pinned to a previously validated public IPv4 address.
function pinnedRedirectHead(url, address) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, {
      method: "HEAD", agent: false, timeout: TIMEOUT_MS,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "user-agent": "SnapyCallResearchPreview/1.0 (+https://pilot.eventnexus.eu)",
        "accept-encoding": "identity",
        connection: "close",
      },
      lookup: (_hostname, options, cb) => {
        if (options?.all) cb(null, [{ address, family: 4 }]);
        else cb(null, address, 4);
      },
    }, response => {
      const status = response.statusCode;
      const location = response.headers.location;
      response.destroy();
      resolve({ status, location });
    });
    req.on("timeout", () => req.destroy(new Error("GROUNDING_HEAD_TIMEOUT")));
    req.on("error", reject);
    req.end();
  });
}

export async function resolveGoogleGroundingLocation(citationUrl, {
  resolve = dnsLookup, head = pinnedRedirectHead,
} = {}) {
  if (!isGoogleGroundingCitation(citationUrl)) {
    return { status: "REJECTED", code: "NOT_GOOGLE_GROUNDING_CITATION" };
  }
  if (typeof resolve !== "function" || typeof head !== "function") {
    throw new TypeError("Trusted grounding resolver dependencies required");
  }
  const citation = publicCitationUrl(citationUrl);
  let response;
  try {
    const googleAddress = await resolvePublicAddress(GOOGLE_HOST, resolve);
    response = await head(new URL(citation), googleAddress);
  } catch {
    return { status: "UNRESOLVED", code: "GROUNDING_REDIRECT_UNAVAILABLE" };
  }
  if (!REDIRECT_CODES.has(response?.status) ||
      typeof response.location !== "string" ||
      response.location.length > 2048) {
    return { status: "UNRESOLVED", code: "GROUNDING_LOCATION_NOT_AVAILABLE" };
  }
  // Never interpret relative redirects, second-hop redirects or credentials
  // as usable destinations. This only accepts an absolute HTTPS header.
  if (!response.location.startsWith("https://")) {
    return { status: "REJECTED", code: "GROUNDING_DESTINATION_INVALID" };
  }
  const destination = publicCitationUrl(response.location);
  if (!destination || isGoogleGroundingCitation(destination) ||
      new URL(destination).hostname === GOOGLE_HOST) {
    return { status: "REJECTED", code: "GROUNDING_DESTINATION_INVALID" };
  }
  try {
    // Validate that the target has a public DNS answer. Do not connect to it:
    // a later independent page-inspection step rechecks DNS and pins its IP.
    await resolvePublicAddress(new URL(destination).hostname, resolve);
  } catch {
    return { status: "REJECTED", code: "GROUNDING_DESTINATION_DNS_REJECTED" };
  }
  return Object.freeze({
    status: "SOURCE_HINT", citationUrl: citation, sourceUrl: destination,
    provenance: "GOOGLE_GROUNDING_LOCATION_HEADER",
    identityVerified: false, emailVerified: false,
    contactCreated: false, sendingEnabled: false,
  });
}
