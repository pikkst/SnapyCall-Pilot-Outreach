import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../web/main.tsx", import.meta.url), "utf8");

test("manual-source panel belongs to ready campaign, never error recovery", () => {
  const error = app.indexOf('campaignProgressStatus === "error" && <p role="alert">');
  const retry = app.indexOf("Retry</button></p>}", error);
  const ready = app.indexOf('campaignProgressStatus === "ready" && campaignProgress && <>', retry);
  const sources = app.indexOf('<section className="campaign-manual-sources"', ready);
  const refresh = app.indexOf("Refresh progress</button>", ready);
  assert.ok(error >= 0 && retry > error && ready > retry);
  assert.ok(sources > ready && refresh > sources);
  assert.equal(app.slice(error, retry).includes("campaign-manual-sources"), false);
});

test("rendered agent animation cannot imply email enrichment or sending is active", () => {
  assert.match(app, /campaignStageTimeline\(campaignProgress\)/);
  assert.match(app, /campaignProgressLastSeen/);
  assert.match(app, /campaignProgressLiveWarning/);
  assert.match(app, /Auto-refresh every 6 seconds/);
  const css = readFileSync(new URL("../web/style.css", import.meta.url), "utf8");
  assert.match(css, /data-stage-state="ACTIVE"/);
  assert.match(css, /prefers-reduced-motion:no-preference/);
});
