// Owner-wide provider-agnostic monetary ledger.
// This is NOT an estimate or price list. Only a separately validated
// provider-specific price contract may pass a worst-case reservation here.
export const MIN_MONTHLY_USD_CENTS = 100;
export const MAX_MONTHLY_USD_CENTS = 100_000;

export class ResearchBudgetExceeded extends Error {
  constructor(message = "Monthly owner budget unavailable or exhausted") {
    super(message);
    this.name = "ResearchBudgetExceeded";
  }
}

export function validateMonthlyBudgetCents(amount) {
  if (!Number.isSafeInteger(amount) ||
      amount < MIN_MONTHLY_USD_CENTS || amount > MAX_MONTHLY_USD_CENTS) {
    throw new TypeError("Budget must be between USD 1 and USD 1,000 in cents");
  }
  return amount;
}

// Test-data exclusions change available application budget, never provider invoices.
// They are backed by immutable, reviewed reservation IDs, not guessed prices.
async function historicalTestExcludedCents(db, ownerId, monthUtc) {
  const result = await db.researchSpendAdjustment.aggregate({
    where: { ownerId, monthUtc, classification: "LEGACY_TEST_ESTIMATE" },
    _sum: { excludedCents: true },
  });
  const cents = result._sum.excludedCents ?? 0;
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new TypeError("Invalid historical budget adjustment");
  }
  return cents;
}

export function utcBudgetMonth(now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("Invalid UTC budget clock");
  }
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function identifiers({ ownerId, workspaceId, reservationId }) {
  if (typeof ownerId !== "string" || !/^c[a-z0-9]{10,40}$/.test(ownerId) ||
      typeof workspaceId !== "string" || !/^c[a-z0-9]{10,40}$/.test(workspaceId) ||
      typeof reservationId !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(reservationId)) {
    throw new TypeError("Authenticated owner/workspace and server reservation ID required");
  }
}

// Call inside an existing transaction. The caller must hold a live workspace
// membership lock. This owner-budget row lock serializes spending across
// *all* workspaces, models, and parallel Node processes belonging to one owner.
export async function reserveOwnerSpend(tx, {
  ownerId, workspaceId, reservationId, worstCaseCents, now = new Date(),
}) {
  identifiers({ ownerId, workspaceId, reservationId });
  if (!Number.isSafeInteger(worstCaseCents) || worstCaseCents < 1 ||
      worstCaseCents > MAX_MONTHLY_USD_CENTS) {
    throw new TypeError("A positive, bounded server-priced reservation is required");
  }
  const budgetRows = await tx.$queryRaw`
    SELECT "monthlyLimitCents" FROM "ResearchOwnerBudget"
    WHERE "ownerId" = ${ownerId} FOR UPDATE`;
  if (budgetRows.length !== 1) throw new ResearchBudgetExceeded();
  const limitCents = validateMonthlyBudgetCents(budgetRows[0].monthlyLimitCents);
  const monthUtc = utcBudgetMonth(now);
  const prior = await tx.researchSpendReservation.findUnique({ where: { id: reservationId } });
  if (prior) {
    if (prior.ownerId !== ownerId || prior.workspaceId !== workspaceId ||
        prior.monthUtc.getTime() !== monthUtc.getTime() ||
        prior.reservedCents !== worstCaseCents) {
      throw new TypeError("Research reservation idempotency conflict");
    }
    return { id: prior.id, status: prior.status, monthUtc, reservedCents: prior.reservedCents };
  }
  const month = await tx.researchSpendMonth.upsert({
    where: { ownerId_monthUtc: { ownerId, monthUtc } },
    create: { ownerId, monthUtc, reservedCents: 0, settledCents: 0 },
    update: {},
  });
  const excluded = await historicalTestExcludedCents(tx, ownerId, monthUtc);
  if (!Number.isSafeInteger(month.settledCents) || excluded > month.settledCents) {
    throw new TypeError("Historical adjustments exceed settled application ledger");
  }
  if (month.reservedCents + (month.settledCents - excluded) +
      worstCaseCents > limitCents) {
    throw new ResearchBudgetExceeded();
  }
  await tx.researchSpendReservation.create({ data: {
    id: reservationId, ownerId, workspaceId, monthUtc,
    reservedCents: worstCaseCents, status: "RESERVED",
  } });
  await tx.researchSpendMonth.update({
    where: { ownerId_monthUtc: { ownerId, monthUtc } },
    data: { reservedCents: { increment: worstCaseCents } },
  });
  return { id: reservationId, status: "RESERVED", monthUtc, reservedCents: worstCaseCents };
}

// Settlement also requires the owner lock and a DB transaction. If the upstream
// call timed out or billing details are ambiguous, charge the full reservation;
// never free uncertain costs based on client claims or missing tool metadata.
export async function settleOwnerSpend(tx, {
  ownerId, workspaceId, reservationId, actualCents = null,
}) {
  identifiers({ ownerId, workspaceId, reservationId });
  const rows = await tx.$queryRaw`
    SELECT "ownerId" FROM "ResearchOwnerBudget"
    WHERE "ownerId" = ${ownerId} FOR UPDATE`;
  if (rows.length !== 1) throw new ResearchBudgetExceeded();
  const item = await tx.researchSpendReservation.findUnique({ where: { id: reservationId } });
  if (!item || item.ownerId !== ownerId || item.workspaceId !== workspaceId) {
    throw new TypeError("Research reservation not found for authenticated owner");
  }
  const chargedCents = actualCents === null ? item.reservedCents : actualCents;
  if (!Number.isSafeInteger(chargedCents) || chargedCents < 0 ||
      chargedCents > item.reservedCents) {
    throw new TypeError("Settled cost cannot exceed the reserved worst case");
  }
  if (item.status === "SETTLED") {
    if (item.chargedCents !== chargedCents) throw new TypeError("Conflicting settlement replay");
    return { id: item.id, status: item.status, chargedCents };
  }
  if (item.status !== "RESERVED") throw new TypeError("Unknown reservation state");
  await tx.researchSpendReservation.update({
    where: { id: reservationId },
    data: { status: "SETTLED", chargedCents, settledAt: new Date() },
  });
  await tx.researchSpendMonth.update({
    where: { ownerId_monthUtc: { ownerId, monthUtc: item.monthUtc } },
    data: {
      reservedCents: { decrement: item.reservedCents },
      settledCents: { increment: chargedCents },
    },
  });
  return { id: reservationId, status: "SETTLED", chargedCents };
}


// Read-only, owner-scoped application ledger snapshot. This reports internal
// estimates/reservations, NOT provider invoices or guaranteed external caps.
export async function readOwnerBudgetSnapshot(db, ownerId, now = new Date()) {
  if (typeof ownerId !== "string" || !/^c[a-z0-9]{10,40}$/.test(ownerId)) {
    throw new TypeError("Authenticated owner required");
  }
  const monthUtc = utcBudgetMonth(now);
  // Count unresolved claims across all UTC months: a previous month's
  // possibly billed reservation must not disappear from diagnostics.
  const staleBefore = new Date(now.getTime() - 5 * 60_000);
  const [budget, month, pendingReservations, staleReservations, oldestPending,
    historicalExcludedCents] = await Promise.all([
    db.researchOwnerBudget.findUnique({
      where: { ownerId }, select: { monthlyLimitCents: true },
    }),
    db.researchSpendMonth.findUnique({
      where: { ownerId_monthUtc: { ownerId, monthUtc } },
      select: { reservedCents: true, settledCents: true },
    }),
    db.researchSpendReservation.count({
      where: { ownerId, monthUtc, status: "RESERVED" },
    }),
    db.researchSpendReservation.count({
      where: { ownerId, status: "RESERVED", createdAt: { lte: staleBefore } },
    }),
    db.researchSpendReservation.findFirst({
      where: { ownerId, status: "RESERVED" },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
    historicalTestExcludedCents(db, ownerId, monthUtc),
  ]);
  const reservedCents = month?.reservedCents ?? 0;
  const settledCents = month?.settledCents ?? 0;
  const monthlyLimitCents = budget?.monthlyLimitCents ?? null;
  if (historicalExcludedCents > settledCents) {
    throw new TypeError("Historical adjustments exceed settled application ledger");
  }
  const effectiveSettledCents = settledCents - historicalExcludedCents;
  if (![reservedCents, settledCents, pendingReservations, staleReservations].every(
    value => Number.isSafeInteger(value) && value >= 0)) {
    throw new TypeError("Invalid persisted spend ledger totals");
  }
  return {
    monthlyLimitCents, currency: "USD", enforcedForPaidSearch: false,
    ledger: {
      monthUtc: monthUtc.toISOString().slice(0, 10),
      reservedCents, settledCents, pendingReservations,
      // Immutable gross committed estimates remain auditable. The effective
      // budget excludes only explicitly reviewed historical test reservations.
      historicalTestExcludedCents: historicalExcludedCents,
      effectiveSettledCents,
      availableCents: monthlyLimitCents === null ? null :
        Math.max(0, monthlyLimitCents - reservedCents - effectiveSettledCents),
      // Values represent app-side budget accounting, never provider invoices.
      billingSource: "application-estimate",
    },
    reconciliation: {
      // Alerts must be read-only. Never auto-refund uncertain provider costs.
      staleAfterMinutes: 5,
      staleReservations,
      oldestPendingAt: oldestPending?.createdAt?.toISOString() ?? null,
      needsReview: staleReservations > 0,
    },
  };
}


// Aggregate operational diagnostics across all owners. Never return owner IDs,
// workspace IDs, API credentials, provider metadata or reservation identifiers.
// Only the already privileged admin route may call this function.
export async function readResearchReconciliationOverview(db, now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("Invalid diagnostics clock");
  }
  const cutoff = new Date(now.getTime() - 5 * 60_000);
  const [pending, stale] = await Promise.all([
    db.researchSpendReservation.aggregate({
      where: { status: "RESERVED" },
      _count: { _all: true }, _sum: { reservedCents: true },
    }),
    db.researchSpendReservation.aggregate({
      where: { status: "RESERVED", createdAt: { lte: cutoff } },
      _count: { _all: true }, _sum: { reservedCents: true },
      _min: { createdAt: true },
    }),
  ]);
  const pendingCount = pending._count._all;
  const staleCount = stale._count._all;
  const pendingCents = pending._sum.reservedCents ?? 0;
  const staleCents = stale._sum.reservedCents ?? 0;
  if ([pendingCount, staleCount, pendingCents, staleCents].some(
    value => !Number.isSafeInteger(value) || value < 0) ||
    staleCount > pendingCount || staleCents > pendingCents) {
    throw new TypeError("Invalid aggregate research ledger");
  }
  return {
    checkedAt: now.toISOString(), staleAfterMinutes: 5,
    pendingReservations: pendingCount, pendingCents,
    staleReservations: staleCount, staleCents,
    oldestStaleAt: stale._min.createdAt?.toISOString() ?? null,
    needsReview: staleCount > 0,
    currency: "USD", billingSource: "application-estimate",
    action: "manual-review-only",
  };
}
