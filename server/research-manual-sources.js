// User-provided URL inputs are queued as research hints, never contacts.
import { z } from "zod";
import { createHash } from "node:crypto";
import { publicCitationUrl } from "./research-evidence.js";

const input = z.object({
  urls: z.array(z.string().min(1).max(2048)).min(1).max(25),
}).strict();

export function normalizeManualResearchSources(value) {
  const { urls } = input.parse(value);
  const result = new Set();
  for (const raw of urls) {
    const url = publicCitationUrl(raw.trim());
    if (!url) throw new TypeError("Only public HTTPS source URLs are accepted");
    const parsed = new URL(url);
    // A signed Google redirect is not an independently inspectable profile.
    if (parsed.hostname === "vertexaisearch.cloud.google.com" &&
        parsed.pathname.startsWith("/grounding-api-redirect/")) {
      throw new TypeError("Provider grounding redirects are not manual source URLs");
    }
    result.add(url);
  }
  return Object.freeze([...result]);
}

// Must run inside a transaction. Serialize inserts and ownership changes on
// the campaign row; membership is locked by the caller in the same transaction.
export async function enqueueManualResearchSources(tx, {
  campaignId, workspaceId, ownerId, urls,
}) {
  const normalized = normalizeManualResearchSources({ urls });
  const rows = await tx.$queryRaw`
    SELECT "id" FROM "ResearchCampaign"
    WHERE "id" = ${campaignId} AND "workspaceId" = ${workspaceId}
      AND "ownerId" = ${ownerId} AND "status" != 'CANCELLED'
    FOR UPDATE`;
  if (rows.length !== 1) return { found: false, added: 0 };
  const insert = await tx.researchCampaignSource.createMany({
    data: normalized.map(normalizedUrl => ({ campaignId, normalizedUrl,
      normalizedUrlHash: createHash("sha256").update(normalizedUrl).digest("hex"),
    })),
    skipDuplicates: true,
  });
  if (insert.count > 0) {
    await tx.auditEvent.create({ data: {
      actorId: ownerId, action: "research.campaign.manual-sources.queued",
      entityId: campaignId, metadata: {
        workspaceId, added: insert.count, submitted: normalized.length,
        // Do not include raw URLs or personally identifiable data in audit metadata.
        providerCallsAuthorized: false,
      },
    } });
  }
  return { found: true, added: insert.count, submitted: normalized.length };
}
