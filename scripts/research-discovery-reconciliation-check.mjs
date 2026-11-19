// Operator-only read-only inspection of an interrupted paid Discovery task.
// Usage: node scripts/research-discovery-reconciliation-check.mjs
//   <campaignId> <workspaceId> <ownerId>
// Requires existing DATABASE_URL and a currently active owner membership.
// Does not repair data, charge an account, replay a task or contact providers.
import { PrismaClient } from "@prisma/client";
import { inspectDiscoveryLeaseReconciliation }
  from "../server/research-campaign-reconciliation.js";

const [campaignId, workspaceId, ownerId, ...extra] = process.argv.slice(2);
if (extra.length || !campaignId || !workspaceId || !ownerId) {
  process.stderr.write("Expected campaignId workspaceId ownerId\n");
  process.exitCode = 2;
} else {
  const db = new PrismaClient();
  try {
    const result = await inspectDiscoveryLeaseReconciliation(db, {
      campaignId, workspaceId, ownerId,
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (result.status !== 200) process.exitCode = 2;
    else if (result.requiresManualProviderBillingReview) process.exitCode = 3;
  } catch {
    // Do not print database errors that may include tenant identifiers.
    process.stderr.write("Discovery reconciliation inspection failed\n");
    process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}
