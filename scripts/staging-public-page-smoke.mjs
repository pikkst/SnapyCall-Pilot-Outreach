// Real-network, bounded source-inspection smoke against a domain controlled
// by the project owner. No paid AI call, credential, tenant data or persistence.
import assert from "node:assert/strict";
import { retrieveCitedPublicPage } from "../server/research-public-pages.js";
import { observedPublicBusinessContacts } from "../server/research-contact-evidence.js";

const url = "https://pilot.eventnexus.eu/privacy.html";
const page = await retrieveCitedPublicPage(url);
assert.equal(page.url, url);
assert.ok(page.text.length > 50 && page.text.length < 65_536);
assert.match(page.text, /Google data and permissions/i);
const contacts = observedPublicBusinessContacts({
  trustedPages: [page], citationUrls: [url],
});
assert.ok(contacts.every(c => c.sourceUrl === url &&
  c.reviewRequired !== false && c.contactPermission === false &&
  c.identityVerified === false));
console.log("PASS real DNS-pinned HTTPS + robots + bounded HTML inspection on project-owned public privacy page");
console.log("Observed business inboxes:", contacts.length,
  "(not verified or imported, no email values logged)");
