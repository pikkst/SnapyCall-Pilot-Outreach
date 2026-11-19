// Read-only, owner-scoped run metrics from persisted worker counters.
// These are units of work, NOT wall-clock completion estimates.
// Never calculate from a fixed timer or authorize another provider call.

const STAGES = ["DISCOVERY", "EMAIL_TRIAGE", "SOURCE_PREPARE", "SOURCE_RUNNING"];
const terminalEmail = new Set(["REVIEW_REQUIRED", "NO_EMAIL", "BLOCKED", "UNCERTAIN"]);

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function bounded(done, total) {
  return { completed: Math.min(count(done), count(total)),
    total: count(total) };
}

export function projectFullRunStageProgress({
  fullRun, discoveryRun, emailCounts = [], sourceApproval = null,
  sourceCycles = [], timing = null,
}) {
  if (!fullRun || typeof fullRun !== "object" || !Array.isArray(emailCounts) ||
      !Array.isArray(sourceCycles)) {
    throw new TypeError("Persisted full-run counters required");
  }
  const counts = new Map(emailCounts.map(row => [
    row.emailTriageStatus, count(row._count?.id),
  ]));
  const observed = [...counts.values()].reduce((a, b) => a + b, 0);
  const inspected = [...terminalEmail].reduce((a, key) =>
    a + (counts.get(key) ?? 0), 0);
  const totalSourceCalls = count(sourceApproval?.startedCalls) +
    sourceCycles.reduce((a, cycle) => a + count(cycle.startedCalls), 0);
  const source = bounded(totalSourceCalls, fullRun.maxSourceCalls);
  const prepareStage = timing?.stages?.find(stage =>
    stage.key === "SOURCE_PREPARE");
  const preparationDone = prepareStage?.finishedAt != null;
  const progress = {
    DISCOVERY: { ...bounded(discoveryRun?.startedTasks, fullRun.maxDiscoveryCalls),
      unit: "searches started" },
    EMAIL_TRIAGE: { ...bounded(inspected, observed),
      unit: "profiles inspected" },
    SOURCE_PREPARE: { completed: preparationDone ? 1 : 0, total: 1,
      unit: "preparation steps" },
    SOURCE_RUNNING: { ...source, unit: "source searches started",
      currentCycle: sourceCycles.findLast(cycle =>
        ["APPROVED", "RUNNING"].includes(cycle.status))?.cycleIndex ??
        (sourceApproval ? 0 : null),
      cyclesCreated: sourceCycles.length },
  };
  return Object.fromEntries(STAGES.map(stage => [
    stage, Object.freeze(progress[stage]),
  ]));
}
