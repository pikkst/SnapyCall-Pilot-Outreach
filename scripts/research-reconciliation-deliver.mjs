// Private operator command, not an app route and not a cron scheduler.
// Send is disabled unless an operator explicitly enables the flag and
// configures a verified recipient/sender and Resend account.
import { PrismaClient } from "@prisma/client";
import { dispatchResearchReconciliationAlert } from "../server/research-reconciliation-delivery.js";

if (process.env.RESEARCH_ALERT_DELIVERY_ENABLED !== "true") {
  process.stdout.write(JSON.stringify({ status: "disabled" }) + "\n");
} else if (!process.env.DATABASE_URL) {
  process.stderr.write("Alert delivery requires a configured database\n");
  process.exitCode = 1;
} else {
  const prisma = new PrismaClient({ log: ["error"] });
  try {
    const result = await dispatchResearchReconciliationAlert(prisma);
    process.stdout.write(JSON.stringify({ status: result.state }) + "\n");
    if (["failed", "manual_review", "claimed_elsewhere"].includes(result.state)) {
      process.exitCode = 2;
    }
  } catch {
    process.stderr.write("Alert delivery failed; check the protected operator console\n");
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
