// Read-only, unauthenticated smoke against the *currently deployed* staging
// service. Never include cookies, tokens, credentials or write requests.
import assert from "node:assert/strict";

const base = "https://pilot.eventnexus.eu";
async function get(path) {
  const response = await fetch(base + path, {
    method: "GET", redirect: "manual", signal: AbortSignal.timeout(12000),
    headers: { accept: path.startsWith("/api/") ? "application/json" : "text/html" },
  });
  assert.ok(response.status < 300, path + " unexpectedly redirected or failed: " + response.status);
  return response;
}

const health = await get("/api/health");
assert.equal(health.status, 200);
assert.deepEqual(await health.json(), { status: "ok" });
console.log("PASS /api/health");

const ready = await get("/api/ready");
assert.equal(ready.status, 200);
const readyResult = await ready.json();
assert.equal(readyResult.status, "ready");
console.log("PASS /api/ready");

const session = await get("/api/session");
assert.equal(session.status, 200);
assert.equal((await session.json()).authenticated, false);
console.log("PASS anonymous /api/session");

const candidates = await fetch(base + "/api/candidates", {
  method: "GET", redirect: "manual", signal: AbortSignal.timeout(12000),
  headers: { accept: "application/json" },
});
assert.equal(candidates.status, 401, "Anonymous users must not list candidates");
console.log("PASS candidate auth boundary (401)");

for (const path of ["/", "/privacy.html", "/terms.html"]) {
  const page = await get(path);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/i);
  console.log("PASS " + path);
}
console.log("STAGING_READ_ONLY_SMOKE_PASS (deployed main; not PR preview)");
