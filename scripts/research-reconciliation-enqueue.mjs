// Opt-in enqueue-only operator command. Never sends email or changes funds.
import { PrismaClient } from "@prisma/client";
import { enqueueResearchReconciliationAlert } from "../server/research-reconciliation-outbox.js";

if (process.env.RESEARCH_ALERT_ENQUEUE_ENABLED !== "true") {
  process.stdout.write(JSON.stringify({ status: "disabled" }) + "\n");
} else if (!process.env.DATABASE_URL) {
  process.stderr.write("Research alert enqueue requires an explicitly configured database\n");
  process.exitCode = 1;
} else {
  const prisma = new PrismaClient({ log: ["error"] });
  try {
    const result = await enqueueResearchReconciliationAlert(prisma);
    process.stdout.write(JSON.stringify({
      status: result.state,
      newlyEnqueued: result.enqueued,
      // No tenant identities or financial details in the operator output.
      delivery: "not-configured",
    }) + "\n");
  } catch {
    process.stderr.write("Research alert enqueue failed\n");
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
