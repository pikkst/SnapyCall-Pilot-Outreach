import test from "node:test";
import assert from "node:assert/strict";
import { isGoogleGroundingCitation, resolveGoogleGroundingLocation }
  from "../server/research-grounding-location.js";

const citation = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/ABCDEFGHIJKLMN==";
const source = "https://experts.example.org/profile/ada";
const publicDns = async () => [{ address: "8.8.8.8", family: 4 }];

test("only exact Google grounding citations qualify", async () => {
  for (const invalid of [
    "https://example.org/profile",
    "https://vertexaisearch.cloud.google.com.evil.org/grounding-api-redirect/ABCDEFGH",
    "http://vertexaisearch.cloud.google.com/grounding-api-redirect/ABCDEFGH",
    "https://vertexaisearch.cloud.google.com/other/ABCDEFGH",
    citation + "?next=https://example.org",
  ]) {
    assert.equal(isGoogleGroundingCitation(invalid), false);
    const result = await resolveGoogleGroundingLocation(invalid, {
      resolve: () => { throw Error("no DNS for rejected input"); },
      head: () => { throw Error("no request for rejected input"); },
    });
    assert.equal(result.code, "NOT_GOOGLE_GROUNDING_CITATION");
  }
  assert.equal(isGoogleGroundingCitation(citation), true);
});

test("returns an unverified public source hint without following or inspecting target", async () => {
  const requests = [], resolvedHosts = [];
  const result = await resolveGoogleGroundingLocation(citation, {
    resolve: async host => {
      resolvedHosts.push(host);
      return publicDns();
    },
    head: async (url, address) => {
      requests.push({ url: String(url), address });
      return { status: 302, location: source };
    },
  });
  assert.deepEqual(requests, [{ url: citation, address: "8.8.8.8" }]);
  assert.deepEqual(resolvedHosts, [
    "vertexaisearch.cloud.google.com", "experts.example.org",
  ]);
  assert.equal(result.status, "SOURCE_HINT");
  assert.equal(result.sourceUrl, source);
  assert.equal(result.citationUrl, citation);
  assert.equal(result.provenance, "GOOGLE_GROUNDING_LOCATION_HEADER");
  assert.equal(result.identityVerified, false);
  assert.equal(result.emailVerified, false);
  assert.equal(result.contactCreated, false);
  assert.equal(result.sendingEnabled, false);
});

test("rejects unsafe, relative, nested and private destinations", async () => {
  for (const location of [
    "/redirect/relative",
    "http://experts.example.org/profile/ada",
    "https://127.0.0.1/",
    "https://user:password@experts.example.org/path",
    "https://vertexaisearch.cloud.google.com/grounding-api-redirect/OTHER0123",
    "https://vertexaisearch.cloud.google.com/other",
  ]) {
    const result = await resolveGoogleGroundingLocation(citation, {
      resolve: publicDns,
      head: async () => ({ status: 302, location }),
    });
    assert.equal(result.status, "REJECTED", location);
  }
  const dnsRejected = await resolveGoogleGroundingLocation(citation, {
    resolve: async host => host === "vertexaisearch.cloud.google.com"
      ? publicDns() : [{ address: "169.254.169.254", family: 4 }],
    head: async () => ({ status: 302, location: source }),
  });
  assert.equal(dnsRejected.code, "GROUNDING_DESTINATION_DNS_REJECTED");
});

test("nonredirect, malformed Location and unreachable Google fail closed", async () => {
  for (const response of [
    { status: 200, location: source },
    { status: 404, location: source },
    { status: 302 },
    { status: 302, location: ["https://one.example.org", "https://two.example.org"] },
  ]) {
    const outcome = await resolveGoogleGroundingLocation(citation, {
      resolve: publicDns, head: async () => response,
    });
    assert.equal(outcome.code, "GROUNDING_LOCATION_NOT_AVAILABLE");
  }
  const noNetwork = await resolveGoogleGroundingLocation(citation, {
    resolve: publicDns, head: async () => { throw Error("timed out"); },
  });
  assert.equal(noNetwork.code, "GROUNDING_REDIRECT_UNAVAILABLE");
  const privateGoogleDns = await resolveGoogleGroundingLocation(citation, {
    resolve: async () => [{ address: "10.0.0.1", family: 4 }],
    head: async () => { throw Error("head must not execute"); },
  });
  assert.equal(privateGoogleDns.code, "GROUNDING_REDIRECT_UNAVAILABLE");
});
