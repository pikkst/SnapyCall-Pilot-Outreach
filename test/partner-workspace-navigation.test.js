import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { singleAuthorizedWorkspaceId } from "../src/partner-workspace-navigation.js";

const partner = {
  authenticated: true,
  userId: "cm_valid_partner_user",
  partners: [{ id: "cm_workspace_one", name: "Snapycall", role: "PARTNER" }],
};

test("sole authorized workspace is selected without granting new permissions", () => {
  assert.equal(singleAuthorizedWorkspaceId(partner), "cm_workspace_one");
  assert.equal(singleAuthorizedWorkspaceId({ ...partner,
    partners: [{ ...partner.partners[0] }, { id: "cm_workspace_two" }] }), null);
  assert.equal(singleAuthorizedWorkspaceId({ ...partner, partners: [] }), null);
  assert.equal(singleAuthorizedWorkspaceId({ ...partner, authenticated: false }), null);
  assert.equal(singleAuthorizedWorkspaceId({ ...partner, userId: null }), null);
  assert.equal(singleAuthorizedWorkspaceId({ ...partner, partners: [{ id: "" }] }), null);
  assert.equal(singleAuthorizedWorkspaceId(null), null);
});

test("dashboard is not mounted with the old candidates/drafts content", () => {
  const source = readFileSync(new URL("../web/main.tsx", import.meta.url), "utf8");
  assert.match(source, /\{\(partnerTab === "candidates" \|\| partnerTab === "drafts"\) && <>/);
  assert.doesNotMatch(source, /\{partnerTab !== "discovery" && <>/);
  assert.match(source, /singleAuthorizedWorkspaceId\(partnerSession\)/);
  assert.match(source, /void viewWorkspace\(onlyWorkspaceId\)/);
});
