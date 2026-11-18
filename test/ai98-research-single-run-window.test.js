import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ui = readFileSync(new URL("../web/main.tsx", import.meta.url), "utf8");
const researchStart = ui.indexOf('{partnerTab === "discovery" && <>');
const researchEnd = ui.indexOf('aria-label="Manual expert lead"', researchStart);
const research = ui.slice(researchStart, researchEnd);

test("Research shows one primary running window and no duplicate KPI cards", () => {
  assert.ok(researchStart >= 0 && researchEnd > researchStart);
  assert.equal((research.match(/aria-label="Research run overview"/g) || []).length, 1);
  assert.doesNotMatch(research, /aria-label="Selected campaign summary"/);
  assert.match(research, /aria-label="Research task completion"/);
  assert.match(research, /campaignProgress\.tasks\.completed/);
  assert.match(research, /campaignProgress\.uniqueSourcedCandidates/);
  assert.match(research, /committedWorstCaseCents/);
  assert.match(research, /You can leave this page/);
});

test("only one expandable technical panel remains, without losing controls", () => {
  assert.equal((research.match(/className="research-run-details"/g) || []).length, 1);
  assert.match(research, /More details and tools/);
  assert.match(research, /Agent pipeline/);
  assert.match(research, /Source resolution agent/);
  assert.match(research, /Public email evidence agent/);
  assert.match(research, /Approved single-run budget/);
  assert.match(research, /Add public source URLs/);
  assert.match(research, /skipUncertainCampaignTask/);
});

test("running view keeps safe stop, read-only findings and owner run approval", () => {
  assert.match(research, /onClick=\{\(\) => void stopCampaignAutonomousRun/);
  assert.match(research, /Stop future searches/);
  assert.match(research, /loadCampaignObservations\(p\.id, campaignProgress\.id\)/);
  assert.match(research, /campaignObservationsStatus !== "idle"/);
  assert.match(research, /aria-label="Saved campaign findings"/);
  assert.match(research, /I approve this maximum reserve/);
  assert.match(research, /approveCampaignAutonomousRun/);
  assert.doesNotMatch(research, /Run ONE Gemini 3 Search cost test|Run one search/);
});

test("older plan success copy is hidden once an actual run is active", () => {
  assert.match(research, /campaignTestNotice && !campaignRunApproval\?\.run/);
  assert.match(research, /!campaignProgress\?\.tasks\.completed/);
  assert.match(research, /campaignRunApproval\?\.run\?\.lastCode === "RUN_LIMIT_REACHED"/);
});

test("activity remains visible between polls, including approved and reconnecting states", () => {
  assert.match(research, /research-run-activity/);
  assert.match(research, /\["APPROVED", "RUNNING"\]\.includes\(campaignRunApproval\.run\.status\)/);
  assert.match(research, /Research is running on the server/);
  assert.match(research, /Waiting for the server to start searching/);
  assert.match(research, /campaignProgressLiveWarning/);
  assert.match(research, /Connection interrupted\. Reconnecting to the server/);
  assert.match(research, /latest confirmed/);
  assert.match(research, /research-run-loading/);
  assert.match(research, /Connecting to saved research progress/);
});
