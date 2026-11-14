// Manual candidate seeds are untrusted references, never verified profiles,
// consent to contact, or permission to harvest a publisher's directory.
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalEvidenceUrl } from "../src/evidence.js";

const schema = z.object({
  manualSeed: z.literal(true),
  name: z.string().trim().min(2).max(160),
  category: z.enum(["AI_AUTOMATION", "COACHING", "MARKETING_GROWTH", "BUSINESS_STRATEGY"]),
  sourceUrl: z.string().max(2048),
}).strict();

export function normalizeManualLeadSeed(value) {
  const input = schema.parse(value);
  const sourceUrl = canonicalEvidenceUrl(input.sourceUrl);
  const canonicalName = input.name.trim().replace(/\s+/g, " ").toLowerCase();
  // A stable tenant-scoped identity key supports idempotent replay without
  // guessing an expert's email, consulting status or contact permissions.
  const discoveryKey = createHash("sha256")
    .update("manual-lead-seed-v1\0" + canonicalName + "\0" + sourceUrl)
    .digest("hex");
  return { name: input.name.trim().replace(/\s+/g, " "),
    category: input.category, sourceUrl, discoveryKey };
}
