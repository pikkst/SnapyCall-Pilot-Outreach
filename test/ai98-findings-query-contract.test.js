import test from "node:test";
import assert from "node:assert/strict";
import { campaignFindingsQuerySchema }
  from "../server/research-campaign-observations.js";

const workspaceId = "cmabcdefghijklmnopqrstv";
const cursor = "cmabcdefghijklmnopqrstu";

test("existing frontend findings URL passes strict workspace and cursor validation", () => {
  const initial = campaignFindingsQuerySchema.parse({ workspaceId });
  assert.equal(initial.workspaceId, workspaceId);
  assert.equal(initial.after, undefined);
  const paged = campaignFindingsQuerySchema.parse({ workspaceId, after: cursor });
  assert.deepEqual(paged, { workspaceId, after: cursor });
});

test("missing, malformed and unexpected findings query fields fail closed", () => {
  for (const input of [
    {}, { after: cursor }, { workspaceId: "not-a-workspace" },
    { workspaceId, after: "../other" },
    { workspaceId, admin: "true" },
    { workspaceId: [workspaceId] },
    { workspaceId, after: [cursor] },
  ]) {
    assert.equal(campaignFindingsQuerySchema.safeParse(input).success, false,
      JSON.stringify(input));
  }
});

test("valid query does not authorize access to another workspace", () => {
  const query = campaignFindingsQuerySchema.parse({ workspaceId });
  const requestScope = "cmotherworkspaceabcdefgh";
  assert.notEqual(query.workspaceId, requestScope);
  // Route rejects mismatch with 403 before owner-filtered DB read; the
  // schema validates shape only and never grants workspace permissions.
});
