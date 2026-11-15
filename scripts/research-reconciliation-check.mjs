// Operator-invoked, read-only diagnostic command. An external scheduler can
// later run this command with a least-privilege DB credential; it does not
// send notifications, settle charges or authorize AI provider calls.
import { PrismaClient } from "@prisma/client";
import { readResearchReconciliationOverview } from "../server/research-budget.js";
import { evaluateResearchReconciliationAlert } from "../server/research-reconciliation-alert.js";

if (process.env.RESEARCH_ALERT_CHECK_ENABLED !== "true") {
  process.stdout.write(JSON.stringify({ status: "disabled" }) + "\n");
} else if (!process.env.DATABASE_URL) {
  process.stderr.write("Research alert check requires an explicitly configured database\n");
  process.exitCode = 1;
} else {
  const prisma = new PrismaClient({ log: ["error"] });
  try {
    const summary = await readResearchReconciliationOverview(prisma);
    const alert = evaluateResearchReconciliationAlert(summary);
    // No owner/workspace IDs or customer details in operational output.
    process.stdout.write(JSON.stringify({
      status: alert.requiresOperatorReview ? "requires_review" : "clear",
      staleCount: alert.staleCount,
      estimatedHeldCents: alert.estimatedHeldCents,
      oldestStaleAt: alert.oldestStaleAt,
      currency: alert.currency,
      billingSource: "application-estimate",
    }) + "\n");
    // 2 is a monitoring signal, not an automatic payment or email action.
    if (alert.requiresOperatorReview) process.exitCode = 2;
  } catch {
    // Do not print raw DB errors, which can contain internal connection info.
    process.stderr.write("Research reconciliation check failed\n");
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
