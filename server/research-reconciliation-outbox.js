import { createHash } from "node:crypto";
import { readResearchReconciliationOverview } from "./research-budget.js";
import { evaluateResearchReconciliationAlert } from "./research-reconciliation-alert.js";

// Invoked only by an explicitly enabled operator job. The alert key is a
// stable digest of the oldest unresolved reservation ID, never a tenant ID.
// Persisting a pending alert does not authorize external email delivery.
export async function enqueueResearchReconciliationAlert(db, now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("Invalid reconciliation clock");
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await db.$transaction(async tx => {
        const before = new Date(now.getTime() - 5 * 60_000);
        const oldest = await tx.researchSpendReservation.findFirst({
          where: { status: "RESERVED", createdAt: { lte: before } },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { id: true, createdAt: true },
        });
        if (!oldest) return { state: "clear", enqueued: false };
        const summary = await readResearchReconciliationOverview(tx, now);
        const alert = evaluateResearchReconciliationAlert(summary);
        if (!alert.requiresOperatorReview ||
            summary.oldestStaleAt !== oldest.createdAt.toISOString()) {
          // Do not persist an alert from inconsistent database snapshots.
          throw new Error("RECONCILIATION_SNAPSHOT_CONFLICT");
        }
        const dedupeKey = createHash("sha256")
          .update("research-stale-v1:" + oldest.id).digest("hex");
        const inserted = await tx.researchReconciliationOutbox.createMany({
          data: [{
            dedupeKey, staleCount: alert.staleCount,
            estimatedHeldCents: alert.estimatedHeldCents,
            firstDetectedAt: now, lastDetectedAt: now,
          }],
          skipDuplicates: true,
        });
        // Never reset SENT or MANUAL_REVIEW back to PENDING on a recheck.
        return { state: "requires_review", enqueued: inserted.count === 1 };
      }, { isolationLevel: "Serializable" });
    } catch (error) {
      if (attempt < 2 && (error?.code === "P2034" ||
          error?.message === "RECONCILIATION_SNAPSHOT_CONFLICT")) continue;
      throw error;
    }
  }
  throw new Error("Reconciliation enqueue retry exhausted");
}
