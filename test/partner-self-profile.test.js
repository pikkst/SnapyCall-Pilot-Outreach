import test from "node:test";
import assert from "node:assert/strict";
import { partnerSelfProfileInput, publicPartnerSelfProfile } from "../server/partner-self-profile.js";

const valid = {
  displayName: "Gary Example",
  jobTitle: "Partner outreach",
  organizationName: "SnapyCall",
  businessPhone: "+1 (212) 555-0199",
  publicWebsite: "https://snapycall.example/about",
  emailSignature: "Gary Example\nSnapyCall",
};

test("self profile preserves validated optional sender details", () => {
  assert.deepEqual(partnerSelfProfileInput.parse(valid), valid);
  assert.deepEqual(partnerSelfProfileInput.parse({
    ...valid, jobTitle: " ", businessPhone: "", publicWebsite: "",
  }), { ...valid, jobTitle: null, businessPhone: null, publicWebsite: null });
});

test("Google account email, role, workspace and implicit sending permissions cannot be edited", () => {
  for (const data of [
    { ...valid, email: "spoof@example.org" },
    { ...valid, googleSub: "attacker" },
    { ...valid, role: "ADMIN" },
    { ...valid, workspaceId: "another-workspace" },
    { ...valid, sendApproved: true },
    { ...valid, htmlSignature: "<script>bad</script>" },
  ]) assert.equal(partnerSelfProfileInput.safeParse(data).success, false);
});

test("reject unsafe website, phone, and oversized signature", () => {
  for (const bad of [
    { ...valid, publicWebsite: "http://snapycall.example" },
    { ...valid, publicWebsite: "https://user:pass@snapycall.example" },
    { ...valid, publicWebsite: "https://localhost" },
    { ...valid, publicWebsite: "javascript:alert(1)" },
    { ...valid, businessPhone: "555\r\nBcc: attacker@example.org" },
    { ...valid, emailSignature: "x".repeat(1001) },
    { ...valid, emailSignature: "\u0000" },
  ]) assert.equal(partnerSelfProfileInput.safeParse(bad).success, false);
});

test("public projection returns no Google subject, memberships, keys or grants", () => {
  assert.deepEqual(publicPartnerSelfProfile({
    ...valid, emailNormalized: "gary@example.org", googleSub: "private-subject",
    encryptedApiKey: "secret", memberships: [{ role: "ADMIN" }],
  }), { ...valid, email: "gary@example.org" });
});
