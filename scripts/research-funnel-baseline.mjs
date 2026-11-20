// Explicitly selected, owner-scoped, read-only RD-01 diagnostic.
import { PrismaClient } from "@prisma/client";
import { loadResearchFunnelSnapshot } from "../server/research-funnel-snapshot-loader.js";
import { summarizeResearchFunnel } from "../server/research-funnel-baseline.js";

const campaignId = process.argv[2];
const environment = process.env.APP_ENVIRONMENT;
const expectedDatabase = process.env.RD01_AUDIT_DATABASE;
const expectedRole = process.env.RD01_AUDIT_ROLE;
const workspaceId = process.env.RESEARCH_WORKSPACE_ID;
const ownerId = process.env.RESEARCH_OWNER_ID;
if (!campaignId || !workspaceId || !ownerId || !environment || !process.env.DATABASE_URL) {
  process.stderr.write("Usage requires campaign ID, APP_ENVIRONMENT, RESEARCH_WORKSPACE_ID, RESEARCH_OWNER_ID and DATABASE_URL\n");
  process.exitCode = 1;
} else {
  const prisma = new PrismaClient({ log: ["error"] });
  try {
    const snapshot = await loadResearchFunnelSnapshot(prisma,
      { campaignId, workspaceId, ownerId, environment, expectedDatabase, expectedRole });
    if (snapshot.code) {
      process.stdout.write(JSON.stringify({ status: "unavailable", code: snapshot.code }) + "\n");
      process.exitCode = 2;
    } else {
      const report = summarizeResearchFunnel(snapshot);
      const output = { status: "ok", environment,
          codeVersion: process.env.GIT_COMMIT_SHA ?? "unknown", campaignStatus: snapshot.campaign.status,
          completeness: snapshot.completeness, funnel: report.stages,
          reasonCodes: report.reasonCodes, accessibility: report.accessibility,
          cost: report.cost, readOnly: true };
      process.stdout.write(JSON.stringify(output) + "\n");
    }
  } catch {
    process.stderr.write("Research funnel snapshot failed\n");
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
